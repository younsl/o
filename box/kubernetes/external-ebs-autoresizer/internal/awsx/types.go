package awsx

import "time"

// Instance is a discovered EC2 instance and its root EBS volume.
type Instance struct {
	ID                string
	Name              string
	Tags              map[string]string
	RootDeviceName    string
	RootVolumeID      string
	RootVolumeSizeGiB int32
}

// VolumeModification describes the most recent EBS volume modification.
type VolumeModification struct {
	State     string
	StartTime time.Time
	TargetGiB int32
}

// CommandResult is the terminal outcome of an SSM RunShellScript invocation.
type CommandResult struct {
	Status   string
	ExitCode int32
	Stdout   string
	Stderr   string
}
