export interface Config {
  platforms?: {
    /**
     * IANA timezone used to bucket visits into calendar days. Default Asia/Seoul.
     * Changing this does not rewrite already-recorded day buckets.
     */
    timezone?: string;
  };
}
