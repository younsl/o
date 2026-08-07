export interface Config {
  opensearchViewer?: {
    /**
     * OpenSearch domain endpoint. Defaults to opensearchAccount.endpoint when omitted.
     */
    endpoint?: string;
    /**
     * Basic auth username for the OpenSearch REST API. Defaults to opensearchAccount.username.
     */
    username?: string;
    /**
     * Basic auth password for the OpenSearch REST API. Defaults to opensearchAccount.password.
     * @visibility secret
     */
    password?: string;
    /**
     * Index patterns to scan independently for field type conflicts.
     * Default: ["*"]
     */
    indexPatterns?: string[];
    /**
     * Named scan targets. Takes precedence over indexPatterns.
     */
    targets?: Array<{
      name?: string;
      indexPattern: string;
    }>;
    /**
     * Index patterns excluded from impact calculations.
     */
    ignoredIndexPatterns?: string[];
    /**
     * Cron expression for periodic conflict impact refresh.
     * Default: every 15 minutes.
     */
    scanCron?: string;
    /**
     * Request timeout for OpenSearch API calls.
     * Default: 15000.
     */
    requestTimeoutMs?: number;
    tls?: {
      /**
       * Reject invalid/self-signed certificates. Set false for self-signed clusters.
       * Defaults to opensearchAccount.tls.rejectUnauthorized or true.
       */
      rejectUnauthorized?: boolean;
    };
  };
}
