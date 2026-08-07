export interface Config {
  opensearchScaling?: {
    /** AWS region the OpenSearch Service domains live in. Default: us-east-1 */
    region?: string;
    /**
     * Optional IAM role ARN to assume for OpenSearch Service API calls.
     * When unset, the backend's ambient credentials (IRSA / instance profile) are used.
     */
    assumeRoleArn?: string;
    /** Default IANA timezone presented in the reservation form. Default: Asia/Seoul */
    defaultTimezone?: string;
    /** Selectable IANA timezones for the reservation form. */
    timezones?: string[];
    /**
     * Fallback data-node instance types for the form. Instance types are normally
     * fetched from the AWS API (ListInstanceTypeDetails) for the selected domain's
     * engine version; this list is only used before a domain is selected or when
     * that API call returns nothing. Free text is always allowed.
     */
    instanceTypes?: string[];
    /**
     * Grace window (hours) after the reserved time during which the scheduler keeps
     * retrying when a change is already in progress. After this, the request fails.
     * Default: 2
     */
    executionGraceHours?: number;
  };
}
