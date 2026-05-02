use aws_sdk_ec2::Client as Ec2Client;

use super::ami::OwnedAmi;

#[derive(Debug)]
pub struct CleanupResult {
    pub deregister_ok: bool,
    pub deregister_err: Option<String>,
    pub snapshots_deleted: Vec<String>,
    pub snapshot_errors: Vec<(String, String)>,
}

pub async fn delete_ami(ec2: &Ec2Client, ami: &OwnedAmi) -> CleanupResult {
    let mut result = CleanupResult {
        deregister_ok: false,
        deregister_err: None,
        snapshots_deleted: Vec::new(),
        snapshot_errors: Vec::new(),
    };

    match ec2.deregister_image().image_id(&ami.ami_id).send().await {
        Ok(_) => result.deregister_ok = true,
        Err(e) => {
            result.deregister_err = Some(e.to_string());
            return result;
        }
    }

    for snap_id in &ami.snapshot_ids {
        match ec2.delete_snapshot().snapshot_id(snap_id).send().await {
            Ok(_) => result.snapshots_deleted.push(snap_id.clone()),
            Err(e) => result
                .snapshot_errors
                .push((snap_id.clone(), e.to_string())),
        }
    }

    result
}
