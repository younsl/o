use std::collections::HashSet;

use aws_sdk_autoscaling::Client as AsgClient;
use aws_sdk_ec2::Client as Ec2Client;
use chrono::{DateTime, Utc};
use futures::stream::{self, StreamExt};

use super::error::AppError;

const API_CONCURRENCY: usize = 10;

#[derive(Debug, Clone)]
pub struct OwnedAmi {
    pub ami_id: String,
    pub name: String,
    pub creation_date: Option<DateTime<Utc>>,
    pub last_launched: Option<DateTime<Utc>>,
    pub snapshot_ids: Vec<String>,
    pub size_gb: i64,
    pub shared: bool,
    /// AMI managed by AWS services (Backup, DLM) — cannot be deregistered directly
    pub managed: bool,
}

#[derive(Debug)]
pub struct ScanResult {
    pub region: String,
    pub owned_amis: Vec<OwnedAmi>,
    pub used_ami_ids: HashSet<String>,
    pub unused_amis: Vec<OwnedAmi>,
}

pub fn compute_unused(
    owned_amis: &[OwnedAmi],
    used_ami_ids: &HashSet<String>,
    min_age_days: u64,
) -> Vec<OwnedAmi> {
    let cutoff = if min_age_days > 0 {
        Some(Utc::now() - chrono::Duration::days(min_age_days as i64))
    } else {
        None
    };

    owned_amis
        .iter()
        .filter(|ami| !used_ami_ids.contains(&ami.ami_id))
        .filter(|ami| !ami.managed)
        .filter(|ami| match (&cutoff, &ami.creation_date) {
            (Some(cutoff), Some(created)) => created < cutoff,
            (Some(_), None) => true,
            (None, _) => true,
        })
        .cloned()
        .collect()
}

pub async fn get_owned_amis(ec2: &Ec2Client) -> anyhow::Result<Vec<OwnedAmi>> {
    let mut amis = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut req = ec2.describe_images().owners("self");
        if let Some(token) = &next_token {
            req = req.next_token(token);
        }
        let resp = req.send().await.map_err(|e| AppError::Ec2(e.to_string()))?;

        for image in resp.images() {
            let ami_id = image.image_id().unwrap_or_default().to_string();
            let name = image.name().unwrap_or_default().to_string();
            let creation_date = image
                .creation_date()
                .and_then(|d| DateTime::parse_from_rfc3339(d).ok())
                .map(|d| d.with_timezone(&Utc));
            let last_launched = image
                .last_launched_time()
                .and_then(|d| DateTime::parse_from_rfc3339(d).ok())
                .map(|d| d.with_timezone(&Utc));

            let mut snapshot_ids = Vec::new();
            let mut size_gb: i64 = 0;
            for bdm in image.block_device_mappings() {
                if let Some(ebs) = bdm.ebs() {
                    if let Some(sid) = ebs.snapshot_id() {
                        snapshot_ids.push(sid.to_string());
                    }
                    if let Some(vol_size) = ebs.volume_size() {
                        size_gb += vol_size as i64;
                    }
                }
            }

            let tags = image.tags();
            let managed = name.starts_with("AwsBackup_")
                || tags.iter().any(|t| {
                    t.key()
                        .is_some_and(|k| k.starts_with("aws:backup:") || k.starts_with("dlm:"))
                });

            amis.push(OwnedAmi {
                ami_id,
                name,
                creation_date,
                last_launched,
                snapshot_ids,
                size_gb,
                shared: false,
                managed,
            });
        }

        next_token = resp.next_token().map(String::from);
        if next_token.is_none() {
            break;
        }
    }

    Ok(amis)
}

pub async fn get_used_ami_ids(ec2: &Ec2Client, asg: &AsgClient) -> anyhow::Result<HashSet<String>> {
    let (instance_amis, lt_amis, asg_amis) = tokio::try_join!(
        get_instance_ami_ids(ec2),
        get_launch_template_ami_ids(ec2),
        get_asg_ami_ids(asg),
    )?;

    let mut used = HashSet::new();
    used.extend(instance_amis);
    used.extend(lt_amis);
    used.extend(asg_amis);
    Ok(used)
}

pub async fn check_shared_amis(ec2: &Ec2Client, amis: &mut [OwnedAmi]) {
    let ami_ids: Vec<String> = amis.iter().map(|a| a.ami_id.clone()).collect();
    let shared_ids: HashSet<String> = stream::iter(ami_ids)
        .map(|ami_id| {
            let ec2 = ec2.clone();
            async move {
                let resp = ec2
                    .describe_image_attribute()
                    .image_id(&ami_id)
                    .attribute(aws_sdk_ec2::types::ImageAttributeName::LaunchPermission)
                    .send()
                    .await;
                match resp {
                    Ok(r) => {
                        let is_shared = r
                            .launch_permissions()
                            .iter()
                            .any(|lp| lp.user_id().is_some() || lp.group().is_some());
                        if is_shared { Some(ami_id) } else { None }
                    }
                    Err(_) => None,
                }
            }
        })
        .buffer_unordered(API_CONCURRENCY)
        .filter_map(|id| async { id })
        .collect()
        .await;

    for ami in amis.iter_mut() {
        if shared_ids.contains(&ami.ami_id) {
            ami.shared = true;
        }
    }
}

async fn get_instance_ami_ids(ec2: &Ec2Client) -> anyhow::Result<HashSet<String>> {
    let mut ami_ids = HashSet::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut req = ec2.describe_instances().filters(
            aws_sdk_ec2::types::Filter::builder()
                .name("instance-state-name")
                .values("pending")
                .values("running")
                .values("shutting-down")
                .values("stopping")
                .values("stopped")
                .build(),
        );
        if let Some(token) = &next_token {
            req = req.next_token(token);
        }
        let resp = req.send().await.map_err(|e| AppError::Ec2(e.to_string()))?;

        for reservation in resp.reservations() {
            for instance in reservation.instances() {
                if let Some(ami_id) = instance.image_id() {
                    ami_ids.insert(ami_id.to_string());
                }
            }
        }

        next_token = resp.next_token().map(String::from);
        if next_token.is_none() {
            break;
        }
    }

    Ok(ami_ids)
}

async fn get_launch_template_ami_ids(ec2: &Ec2Client) -> anyhow::Result<HashSet<String>> {
    let mut lt_ids = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut req = ec2.describe_launch_templates();
        if let Some(token) = &next_token {
            req = req.next_token(token);
        }
        let resp = req.send().await.map_err(|e| AppError::Ec2(e.to_string()))?;

        for lt in resp.launch_templates() {
            if let Some(id) = lt.launch_template_id() {
                lt_ids.push(id.to_string());
            }
        }

        next_token = resp.next_token().map(String::from);
        if next_token.is_none() {
            break;
        }
    }

    let pairs: Vec<(String, String)> = lt_ids
        .into_iter()
        .flat_map(|id| {
            let a = (id.clone(), "$Latest".to_string());
            let b = (id, "$Default".to_string());
            [a, b]
        })
        .collect();

    let ami_ids: HashSet<String> = stream::iter(pairs)
        .map(|(lt_id, ver)| {
            let ec2 = ec2.clone();
            async move {
                ec2.describe_launch_template_versions()
                    .launch_template_id(&lt_id)
                    .versions(&ver)
                    .send()
                    .await
                    .ok()
                    .into_iter()
                    .flat_map(|r| {
                        r.launch_template_versions()
                            .iter()
                            .filter_map(|v| {
                                v.launch_template_data()
                                    .and_then(|d| d.image_id())
                                    .map(String::from)
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            }
        })
        .buffer_unordered(API_CONCURRENCY)
        .flat_map(stream::iter)
        .collect()
        .await;

    Ok(ami_ids)
}

async fn get_asg_ami_ids(asg: &AsgClient) -> anyhow::Result<HashSet<String>> {
    let mut ami_ids = HashSet::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut req = asg.describe_auto_scaling_groups();
        if let Some(token) = &next_token {
            req = req.next_token(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::AutoScaling(e.to_string()))?;

        for group in resp.auto_scaling_groups() {
            if let Some(lc_name) = group.launch_configuration_name()
                && let Ok(lc_resp) = asg
                    .describe_launch_configurations()
                    .launch_configuration_names(lc_name)
                    .send()
                    .await
            {
                for lc in lc_resp.launch_configurations() {
                    if let Some(ami_id) = lc.image_id() {
                        ami_ids.insert(ami_id.to_string());
                    }
                }
            }

            if let Some(policy) = group.mixed_instances_policy()
                && let Some(lt_spec) = policy.launch_template()
            {
                for ovr in lt_spec.overrides() {
                    if let Some(ami_id) = ovr.image_id() {
                        ami_ids.insert(ami_id.to_string());
                    }
                }
            }
        }

        next_token = resp.next_token().map(String::from);
        if next_token.is_none() {
            break;
        }
    }

    Ok(ami_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::config::{Credentials, Region};
    use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};
    use aws_smithy_types::body::SdkBody;
    use chrono::{Duration, Utc};

    fn make_ami(id: &str, days_old: i64, managed: bool) -> OwnedAmi {
        OwnedAmi {
            ami_id: id.to_string(),
            name: format!("test-{id}"),
            creation_date: Some(Utc::now() - Duration::days(days_old)),
            last_launched: None,
            snapshot_ids: vec![],
            size_gb: 8,
            shared: false,
            managed,
        }
    }

    #[test]
    fn test_compute_unused_filters_used_amis() {
        let amis = vec![make_ami("ami-1", 30, false), make_ami("ami-2", 30, false)];
        let used: HashSet<String> = ["ami-1".to_string()].into();
        let unused = compute_unused(&amis, &used, 0);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].ami_id, "ami-2");
    }

    #[test]
    fn test_compute_unused_filters_managed_amis() {
        let amis = vec![make_ami("ami-1", 30, true), make_ami("ami-2", 30, false)];
        let unused = compute_unused(&amis, &HashSet::new(), 0);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].ami_id, "ami-2");
    }

    #[test]
    fn test_compute_unused_filters_by_min_age() {
        let amis = vec![
            make_ami("ami-old", 60, false),
            make_ami("ami-new", 5, false),
        ];
        let unused = compute_unused(&amis, &HashSet::new(), 30);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].ami_id, "ami-old");
    }

    #[test]
    fn test_compute_unused_no_creation_date_with_age_filter() {
        let mut ami = make_ami("ami-1", 0, false);
        ami.creation_date = None;
        let amis = vec![ami];
        let unused = compute_unused(&amis, &HashSet::new(), 30);
        assert_eq!(
            unused.len(),
            1,
            "AMIs without creation date should be included"
        );
    }

    #[test]
    fn test_compute_unused_no_filter() {
        let amis = vec![make_ami("ami-1", 5, false), make_ami("ami-2", 10, false)];
        let unused = compute_unused(&amis, &HashSet::new(), 0);
        assert_eq!(unused.len(), 2);
    }

    #[test]
    fn test_compute_unused_all_filtered() {
        let amis = vec![make_ami("ami-1", 30, true)];
        let used: HashSet<String> = ["ami-1".to_string()].into();
        let unused = compute_unused(&amis, &used, 0);
        assert!(unused.is_empty());
    }

    #[test]
    fn test_compute_unused_empty_input() {
        let unused = compute_unused(&[], &HashSet::new(), 0);
        assert!(unused.is_empty());
    }

    #[test]
    fn test_compute_unused_combined_filters() {
        let amis = vec![
            make_ami("ami-used", 60, false),
            make_ami("ami-managed", 60, true),
            make_ami("ami-young", 5, false),
            make_ami("ami-target", 60, false),
        ];
        let used: HashSet<String> = ["ami-used".to_string()].into();
        let unused = compute_unused(&amis, &used, 30);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].ami_id, "ami-target");
    }

    // -- StaticReplayClient helpers --

    fn mock_ec2(events: Vec<ReplayEvent>) -> Ec2Client {
        let http_client = StaticReplayClient::new(events);
        let config = aws_sdk_ec2::Config::builder()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::for_tests())
            .http_client(http_client)
            .build();
        Ec2Client::from_conf(config)
    }

    fn mock_asg(events: Vec<ReplayEvent>) -> AsgClient {
        let http_client = StaticReplayClient::new(events);
        let config = aws_sdk_autoscaling::Config::builder()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::for_tests())
            .http_client(http_client)
            .build();
        AsgClient::from_conf(config)
    }

    fn ec2_event(body: &str) -> ReplayEvent {
        ReplayEvent::new(
            http::Request::builder()
                .uri("https://ec2.us-east-1.amazonaws.com/")
                .body(SdkBody::empty())
                .unwrap(),
            http::Response::builder()
                .status(200)
                .body(SdkBody::from(body))
                .unwrap(),
        )
    }

    fn asg_event(body: &str) -> ReplayEvent {
        ReplayEvent::new(
            http::Request::builder()
                .uri("https://autoscaling.us-east-1.amazonaws.com/")
                .body(SdkBody::empty())
                .unwrap(),
            http::Response::builder()
                .status(200)
                .body(SdkBody::from(body))
                .unwrap(),
        )
    }

    // -- get_owned_amis tests --

    #[tokio::test]
    async fn test_get_owned_amis_basic() {
        let xml = r#"<DescribeImagesResponse>
            <imagesSet>
                <item>
                    <imageId>ami-aaa</imageId>
                    <name>my-image</name>
                    <creationDate>2024-01-15T10:00:00.000Z</creationDate>
                    <lastLaunchedTime>2024-06-01T00:00:00.000Z</lastLaunchedTime>
                    <blockDeviceMapping>
                        <item>
                            <ebs>
                                <snapshotId>snap-001</snapshotId>
                                <volumeSize>20</volumeSize>
                            </ebs>
                        </item>
                        <item>
                            <ebs>
                                <snapshotId>snap-002</snapshotId>
                                <volumeSize>50</volumeSize>
                            </ebs>
                        </item>
                    </blockDeviceMapping>
                    <tagSet>
                        <item><key>Name</key><value>test</value></item>
                    </tagSet>
                </item>
            </imagesSet>
        </DescribeImagesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let amis = get_owned_amis(&ec2).await.unwrap();

        assert_eq!(amis.len(), 1);
        assert_eq!(amis[0].ami_id, "ami-aaa");
        assert_eq!(amis[0].name, "my-image");
        assert!(amis[0].creation_date.is_some());
        assert!(amis[0].last_launched.is_some());
        assert_eq!(amis[0].snapshot_ids, vec!["snap-001", "snap-002"]);
        assert_eq!(amis[0].size_gb, 70);
        assert!(!amis[0].managed);
        assert!(!amis[0].shared);
    }

    #[tokio::test]
    async fn test_get_owned_amis_pagination() {
        let page1 = r#"<DescribeImagesResponse>
            <imagesSet>
                <item>
                    <imageId>ami-page1</imageId>
                    <name>page1</name>
                    <blockDeviceMapping/>
                    <tagSet/>
                </item>
            </imagesSet>
            <nextToken>token123</nextToken>
        </DescribeImagesResponse>"#;

        let page2 = r#"<DescribeImagesResponse>
            <imagesSet>
                <item>
                    <imageId>ami-page2</imageId>
                    <name>page2</name>
                    <blockDeviceMapping/>
                    <tagSet/>
                </item>
            </imagesSet>
        </DescribeImagesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(page1), ec2_event(page2)]);
        let amis = get_owned_amis(&ec2).await.unwrap();

        assert_eq!(amis.len(), 2);
        assert_eq!(amis[0].ami_id, "ami-page1");
        assert_eq!(amis[1].ami_id, "ami-page2");
    }

    #[tokio::test]
    async fn test_get_owned_amis_managed_detection() {
        let xml = r#"<DescribeImagesResponse>
            <imagesSet>
                <item>
                    <imageId>ami-backup</imageId>
                    <name>AwsBackup_20240101</name>
                    <blockDeviceMapping/>
                    <tagSet/>
                </item>
                <item>
                    <imageId>ami-dlm</imageId>
                    <name>normal-name</name>
                    <blockDeviceMapping/>
                    <tagSet>
                        <item><key>dlm:managed</key><value>true</value></item>
                    </tagSet>
                </item>
                <item>
                    <imageId>ami-normal</imageId>
                    <name>my-app</name>
                    <blockDeviceMapping/>
                    <tagSet/>
                </item>
            </imagesSet>
        </DescribeImagesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let amis = get_owned_amis(&ec2).await.unwrap();

        assert_eq!(amis.len(), 3);
        assert!(amis[0].managed, "AwsBackup_ prefix should be managed");
        assert!(amis[1].managed, "dlm: tag should be managed");
        assert!(!amis[2].managed);
    }

    #[tokio::test]
    async fn test_get_owned_amis_empty() {
        let xml = r#"<DescribeImagesResponse>
            <imagesSet/>
        </DescribeImagesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let amis = get_owned_amis(&ec2).await.unwrap();
        assert!(amis.is_empty());
    }

    #[tokio::test]
    async fn test_get_owned_amis_no_optional_fields() {
        let xml = r#"<DescribeImagesResponse>
            <imagesSet>
                <item>
                    <imageId>ami-minimal</imageId>
                    <name>minimal</name>
                    <blockDeviceMapping/>
                    <tagSet/>
                </item>
            </imagesSet>
        </DescribeImagesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let amis = get_owned_amis(&ec2).await.unwrap();

        assert_eq!(amis.len(), 1);
        assert!(amis[0].creation_date.is_none());
        assert!(amis[0].last_launched.is_none());
        assert!(amis[0].snapshot_ids.is_empty());
        assert_eq!(amis[0].size_gb, 0);
    }

    // -- get_instance_ami_ids tests --

    #[tokio::test]
    async fn test_get_instance_ami_ids_basic() {
        let xml = r#"<DescribeInstancesResponse>
            <reservationSet>
                <item>
                    <instancesSet>
                        <item><imageId>ami-inst1</imageId></item>
                        <item><imageId>ami-inst2</imageId></item>
                    </instancesSet>
                </item>
                <item>
                    <instancesSet>
                        <item><imageId>ami-inst3</imageId></item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let ids = get_instance_ami_ids(&ec2).await.unwrap();

        assert_eq!(ids.len(), 3);
        assert!(ids.contains("ami-inst1"));
        assert!(ids.contains("ami-inst2"));
        assert!(ids.contains("ami-inst3"));
    }

    #[tokio::test]
    async fn test_get_instance_ami_ids_pagination() {
        let page1 = r#"<DescribeInstancesResponse>
            <reservationSet>
                <item>
                    <instancesSet>
                        <item><imageId>ami-p1</imageId></item>
                    </instancesSet>
                </item>
            </reservationSet>
            <nextToken>tok</nextToken>
        </DescribeInstancesResponse>"#;

        let page2 = r#"<DescribeInstancesResponse>
            <reservationSet>
                <item>
                    <instancesSet>
                        <item><imageId>ami-p2</imageId></item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(page1), ec2_event(page2)]);
        let ids = get_instance_ami_ids(&ec2).await.unwrap();

        assert_eq!(ids.len(), 2);
        assert!(ids.contains("ami-p1"));
        assert!(ids.contains("ami-p2"));
    }

    #[tokio::test]
    async fn test_get_instance_ami_ids_dedup() {
        let xml = r#"<DescribeInstancesResponse>
            <reservationSet>
                <item>
                    <instancesSet>
                        <item><imageId>ami-same</imageId></item>
                        <item><imageId>ami-same</imageId></item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let ids = get_instance_ami_ids(&ec2).await.unwrap();
        assert_eq!(ids.len(), 1);
    }

    // -- get_launch_template_ami_ids tests --

    #[tokio::test]
    async fn test_get_launch_template_ami_ids_basic() {
        let lt_list = r#"<DescribeLaunchTemplatesResponse>
            <launchTemplates>
                <item><launchTemplateId>lt-001</launchTemplateId></item>
            </launchTemplates>
        </DescribeLaunchTemplatesResponse>"#;

        let lt_ver = r#"<DescribeLaunchTemplateVersionsResponse>
            <launchTemplateVersionSet>
                <item>
                    <launchTemplateData>
                        <imageId>ami-lt1</imageId>
                    </launchTemplateData>
                </item>
            </launchTemplateVersionSet>
        </DescribeLaunchTemplateVersionsResponse>"#;

        // 1 describe_launch_templates + 2 describe_launch_template_versions ($Latest, $Default)
        let ec2 = mock_ec2(vec![
            ec2_event(lt_list),
            ec2_event(lt_ver),
            ec2_event(lt_ver),
        ]);
        let ids = get_launch_template_ami_ids(&ec2).await.unwrap();

        assert!(ids.contains("ami-lt1"));
    }

    #[tokio::test]
    async fn test_get_launch_template_ami_ids_empty() {
        let xml = r#"<DescribeLaunchTemplatesResponse>
            <launchTemplates/>
        </DescribeLaunchTemplatesResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let ids = get_launch_template_ami_ids(&ec2).await.unwrap();
        assert!(ids.is_empty());
    }

    // -- get_asg_ami_ids tests --

    #[tokio::test]
    async fn test_get_asg_ami_ids_launch_config() {
        let asg_xml = r#"<DescribeAutoScalingGroupsResponse>
            <DescribeAutoScalingGroupsResult>
                <AutoScalingGroups>
                    <member>
                        <AutoScalingGroupName>asg-1</AutoScalingGroupName>
                        <LaunchConfigurationName>lc-old</LaunchConfigurationName>
                        <MinSize>1</MinSize>
                        <MaxSize>3</MaxSize>
                        <DesiredCapacity>2</DesiredCapacity>
                        <DefaultCooldown>300</DefaultCooldown>
                        <AvailabilityZones><member>us-east-1a</member></AvailabilityZones>
                        <HealthCheckType>EC2</HealthCheckType>
                        <CreatedTime>2024-01-01T00:00:00Z</CreatedTime>
                    </member>
                </AutoScalingGroups>
            </DescribeAutoScalingGroupsResult>
        </DescribeAutoScalingGroupsResponse>"#;

        let lc_xml = r#"<DescribeLaunchConfigurationsResponse>
            <DescribeLaunchConfigurationsResult>
                <LaunchConfigurations>
                    <member>
                        <LaunchConfigurationName>lc-old</LaunchConfigurationName>
                        <ImageId>ami-lc1</ImageId>
                        <InstanceType>m5.large</InstanceType>
                        <CreatedTime>2024-01-01T00:00:00Z</CreatedTime>
                    </member>
                </LaunchConfigurations>
            </DescribeLaunchConfigurationsResult>
        </DescribeLaunchConfigurationsResponse>"#;

        let asg = mock_asg(vec![asg_event(asg_xml), asg_event(lc_xml)]);
        let ids = get_asg_ami_ids(&asg).await.unwrap();

        assert_eq!(ids.len(), 1);
        assert!(ids.contains("ami-lc1"));
    }

    #[tokio::test]
    async fn test_get_asg_ami_ids_mixed_instances_policy() {
        let xml = r#"<DescribeAutoScalingGroupsResponse>
            <DescribeAutoScalingGroupsResult>
                <AutoScalingGroups>
                    <member>
                        <AutoScalingGroupName>asg-mix</AutoScalingGroupName>
                        <MinSize>1</MinSize>
                        <MaxSize>5</MaxSize>
                        <DesiredCapacity>3</DesiredCapacity>
                        <DefaultCooldown>300</DefaultCooldown>
                        <AvailabilityZones><member>us-east-1a</member></AvailabilityZones>
                        <HealthCheckType>EC2</HealthCheckType>
                        <CreatedTime>2024-01-01T00:00:00Z</CreatedTime>
                        <MixedInstancesPolicy>
                            <LaunchTemplate>
                                <Overrides>
                                    <member><ImageId>ami-ovr1</ImageId></member>
                                    <member><ImageId>ami-ovr2</ImageId></member>
                                </Overrides>
                            </LaunchTemplate>
                        </MixedInstancesPolicy>
                    </member>
                </AutoScalingGroups>
            </DescribeAutoScalingGroupsResult>
        </DescribeAutoScalingGroupsResponse>"#;

        let asg = mock_asg(vec![asg_event(xml)]);
        let ids = get_asg_ami_ids(&asg).await.unwrap();

        assert_eq!(ids.len(), 2);
        assert!(ids.contains("ami-ovr1"));
        assert!(ids.contains("ami-ovr2"));
    }

    #[tokio::test]
    async fn test_get_asg_ami_ids_empty() {
        let xml = r#"<DescribeAutoScalingGroupsResponse>
            <DescribeAutoScalingGroupsResult>
                <AutoScalingGroups/>
            </DescribeAutoScalingGroupsResult>
        </DescribeAutoScalingGroupsResponse>"#;

        let asg = mock_asg(vec![asg_event(xml)]);
        let ids = get_asg_ami_ids(&asg).await.unwrap();
        assert!(ids.is_empty());
    }

    // -- check_shared_amis tests --

    #[tokio::test]
    async fn test_check_shared_amis_marks_shared() {
        let xml = r#"<DescribeImageAttributeResponse>
            <imageId>ami-shared</imageId>
            <launchPermission>
                <item><userId>123456789012</userId></item>
            </launchPermission>
        </DescribeImageAttributeResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let mut amis = vec![OwnedAmi {
            ami_id: "ami-shared".into(),
            name: "shared".into(),
            creation_date: None,
            last_launched: None,
            snapshot_ids: vec![],
            size_gb: 8,
            shared: false,
            managed: false,
        }];

        check_shared_amis(&ec2, &mut amis).await;
        assert!(amis[0].shared);
    }

    #[tokio::test]
    async fn test_check_shared_amis_not_shared() {
        let xml = r#"<DescribeImageAttributeResponse>
            <imageId>ami-private</imageId>
            <launchPermission/>
        </DescribeImageAttributeResponse>"#;

        let ec2 = mock_ec2(vec![ec2_event(xml)]);
        let mut amis = vec![OwnedAmi {
            ami_id: "ami-private".into(),
            name: "private".into(),
            creation_date: None,
            last_launched: None,
            snapshot_ids: vec![],
            size_gb: 8,
            shared: false,
            managed: false,
        }];

        check_shared_amis(&ec2, &mut amis).await;
        assert!(!amis[0].shared);
    }
}
