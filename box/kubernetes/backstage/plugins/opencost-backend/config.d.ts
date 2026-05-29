export interface Config {
  opencost?: {
    /**
     * IANA timezone for billing day boundaries (e.g. Asia/Seoul).
     * Determines when a "day" starts/ends for cost collection.
     * Default: UTC
     */
    timezone?: string;
    clusters?: Array<{
      /** Cluster identifier used in API calls */
      name: string;
      /** Display name for the cluster */
      title?: string;
      /** OpenCost API base URL (e.g. http://opencost.example.com:9090) */
      url?: string;
    }>;
  };
}
