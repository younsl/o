use std::collections::HashSet;

use aws_sdk_autoscaling::Client as AsgClient;
use aws_sdk_ec2::Client as Ec2Client;
use chrono::{DateTime, Utc};
use futures::stream::{self, StreamExt};

use crate::error::AppError;

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
                        if is_shared {
                            Some(ami_id)
                        } else {
                            None
                        }
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
            if let Some(lc_name) = group.launch_configuration_name() {
                if let Ok(lc_resp) = asg
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
            }

            if let Some(policy) = group.mixed_instances_policy() {
                if let Some(lt_spec) = policy.launch_template() {
                    for ovr in lt_spec.overrides() {
                        if let Some(ami_id) = ovr.image_id() {
                            ami_ids.insert(ami_id.to_string());
                        }
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
