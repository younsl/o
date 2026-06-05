export interface Config {
  opensearchAccount?: {
    /** OpenSearch base URL, e.g. https://opensearch.example.com:9200 */
    endpoint?: string;
    /** Admin username for the Security API */
    username?: string;
    /**
     * Admin password for the Security API
     * @visibility secret
     */
    password?: string;
    /**
     * When true (default), create/delete go through an approval workflow.
     * When false, authorized requests execute immediately.
     */
    requiresApproval?: boolean;
    tls?: {
      /** Reject self-signed/invalid certs. Default true. Set false for self-signed clusters. */
      rejectUnauthorized?: boolean;
    };
  };
}
