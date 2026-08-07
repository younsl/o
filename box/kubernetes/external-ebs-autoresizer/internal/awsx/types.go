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

// Volume is an attached EBS volume and its performance configuration. Throughput
// and IOPS are only configurable on gp3, io1, and io2; on other volume types EC2
// reports throughput as 0 and the recommender treats them as out of scope.
type Volume struct {
	ID string
	// Type is the EBS volume type (gp3, gp2, io2, ...).
	Type string
	// Device is the guest device name the volume is attached as (e.g. /dev/xvda).
	Device     string
	InstanceID string
	SizeGiB    int32
	// ThroughputMiBps is the provisioned throughput in MiB/s.
	ThroughputMiBps int32
	IOPS            int32
}

// EBSCaps is the EBS bandwidth an instance type can drive, independent of how
// much the attached volumes provision. Both values are in MB/s (decimal), the
// unit DescribeInstanceTypes reports; converting to the MiB/s unit gp3
// throughput is configured in is the caller's job.
//
// BaselineMBps is the rate the instance sustains indefinitely. MaximumMBps is
// the burst rate, which on burstable-bandwidth instance types is credit-limited
// and cannot be sustained. On non-burstable types the two are equal.
type EBSCaps struct {
	BaselineMBps float64
	MaximumMBps  float64
}

// ModifySpec is one ModifyVolume request. SizeGiB is always sent; the
// throughput and IOPS fields are omitted from the request when zero, leaving
// those dimensions of the volume untouched. Bundling them into the size call
// matters because EC2 allows one modification per volume per 6 hours: a
// combined request spends the same slot a size-only request would.
type ModifySpec struct {
	SizeGiB         int32
	ThroughputMiBps int32
	IOPS            int32
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
