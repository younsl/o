export interface Config {
  app: {
    /**
     * Feature flags for custom plugins
     * @visibility frontend
     */
    plugins?: {
      /**
       * Enable or disable Catalog Health (catalog-health) plugin
       * @visibility frontend
       */
      catalogHealth?: boolean;
      /**
       * Enable or disable ArgoCD AppSet plugin
       * @visibility frontend
       */
      argocdAppSet?: boolean;
      /**
       * Enable or disable IAM User Audit plugin
       * @visibility frontend
       */
      iamUserAudit?: boolean;
    };
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
