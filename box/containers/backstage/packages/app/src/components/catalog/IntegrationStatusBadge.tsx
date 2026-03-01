import React from 'react';
import { Box, Text, TooltipTrigger, Tooltip } from '@backstage/ui';
import './IntegrationStatusBadge.css';

export type ConnectionStatus = 'loading' | 'connected' | 'disconnected' | 'error';

export interface IntegrationStatusBadgeProps {
  label: string;
  status: ConnectionStatus;
  pluginUrl: string;
  tooltipConnected?: string;
  tooltipDisconnected?: string;
  tooltipLoading?: string;
  tooltipError?: string;
}

/**
 * A reusable status badge component that displays integration connection status.
 * Shows a label and LED indicator, clickable to open plugin documentation.
 */
export const IntegrationStatusBadge = ({
  label,
  status,
  pluginUrl,
  tooltipConnected = 'Integration is active. Click to view plugin docs.',
  tooltipDisconnected = 'Not connected. Click to view setup instructions.',
  tooltipLoading = 'Checking connection...',
  tooltipError = 'Connection failed. Click to view setup instructions.',
}: IntegrationStatusBadgeProps) => {
  const handleClick = () => {
    window.open(pluginUrl, '_blank', 'noopener,noreferrer');
  };

  const getTooltip = () => {
    switch (status) {
      case 'loading':
        return tooltipLoading;
      case 'connected':
        return tooltipConnected;
      case 'error':
        return tooltipError;
      default:
        return tooltipDisconnected;
    }
  };

  const getLedClass = () => {
    switch (status) {
      case 'connected':
        return 'integration-status-led integration-status-led--connected';
      case 'error':
        return 'integration-status-led integration-status-led--error';
      default:
        return 'integration-status-led integration-status-led--disconnected';
    }
  };

  return (
    <TooltipTrigger>
      <Box
        className="integration-status-badge"
        onClick={handleClick}
        role="button"
      >
        <Text className="integration-status-badge-label">{label}</Text>
        {status === 'loading' ? (
          <span className="integration-status-spinner" />
        ) : (
          <span className={getLedClass()} />
        )}
      </Box>
      <Tooltip>{getTooltip()}</Tooltip>
    </TooltipTrigger>
  );
};
