export interface Config {
  /**
   * ArgoCD ApplicationSet plugin configuration
   */
  argocdApplicationSet?: {
    /**
     * Enable or disable the plugin
     * @visibility frontend
     */
    enabled?: boolean;
  };
  app: {
    /**
     * Internal platform services for developers
     * @visibility frontend
     */
    platforms?: Array<{
      /**
       * Platform name
       * @visibility frontend
       */
      name: string;
      /**
       * Category for grouping
       * @visibility frontend
       */
      category: string;
      /**
       * Platform description
       * @visibility frontend
       */
      description: string;
      /**
       * Platform URL
       * @visibility frontend
       */
      url?: string;
      /**
       * Logo URL
       * @visibility frontend
       */
      logo: string;
      /**
       * Tags (comma-separated)
       * @visibility frontend
       */
      tags?: string;
    }>;
  };
}
