mod client;
mod status;
mod tags;

pub use client::Ec2Client;

#[derive(Debug, Clone)]
pub struct InstanceStatus {
    pub instance_id: String,
    pub instance_name: Option<String>,
    pub instance_type: String,
    pub availability_zone: String,
    pub system_status: String,
    pub instance_status: String,
    pub failure_count: u32,
}
