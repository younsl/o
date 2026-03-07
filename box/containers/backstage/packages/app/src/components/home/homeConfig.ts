import React from 'react';
import {
  KubernetesIcon,
  ArgocdIcon,
  CategoryIcon,
  ExtensionIcon,
  CloudUploadIcon,
  SecurityIcon,
  HealthIcon,
} from './icons';

export interface QuickLinkItem {
  url: string;
  label: string;
  Icon: React.FC<{ style?: React.CSSProperties }>;
  description: string;
  badge?: number;
}

export const quickLinks: QuickLinkItem[] = [
  { url: '/platforms', label: 'Platforms', Icon: KubernetesIcon, description: 'Internal platform services' },
  { url: '/catalog', label: 'Catalog', Icon: CategoryIcon, description: 'Browse all registered entities' },
  { url: '/api-docs', label: 'APIs', Icon: ExtensionIcon, description: 'Explore API documentation' },
  { url: '/openapi-registry', label: 'API Registry', Icon: CloudUploadIcon, description: 'Upload and manage OpenAPI specs' },
  { url: '/argocd-appset', label: 'ArgoCD', Icon: ArgocdIcon, description: 'Manage ArgoCD ApplicationSets' },
  { url: '/iam-user-audit', label: 'IAM Audit', Icon: SecurityIcon, description: 'Audit IAM users and manage credentials' },
  { url: '/catalog-health', label: 'Catalog Health', Icon: HealthIcon, description: 'Analyze catalog-info.yaml coverage' },
];

export const searchTypeLabels: Record<string, string> = {
  'software-catalog': 'Catalog',
  techdocs: 'Docs',
  'api-docs': 'API',
};

export const searchTypeBadgeColors: Record<string, string> = {
  'software-catalog': '#3b82f6',
  techdocs: '#10b981',
  'api-docs': '#8b5cf6',
};
