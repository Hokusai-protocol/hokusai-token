import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../utils/logger';
import { StateAlert } from './state-tracker';
import { EventAlert, TradeEvent, SecurityEvent, FeeEvent } from './event-listener';

/**
 * Alert Manager
 *
 * Handles alert notifications via:
 * - Email (AWS SES)
 * - Rate limiting to prevent alert storms
 * - Alert aggregation and deduplication
 */

export interface AlertManagerConfig {
  enabled: boolean;
  emailEnabled: boolean;
  emailRecipients: string[];
  emailFrom: string;
  awsSesRegion: string;

  // Rate limiting (per alert type)
  maxAlertsPerHour: number;
  maxAlertsPerDay: number;

  // Deduplication window (ms)
  deduplicationWindowMs: number;
}

interface AlertRecord {
  alert: StateAlert | EventAlert;
  timestamp: number;
  sentCount: number;
  lastSentTime: number;
}

export class AlertManager {
  private config: AlertManagerConfig;
  private sesClient: SESClient;

  // Alert tracking for rate limiting
  private alertHistory: Map<string, AlertRecord[]> = new Map();
  private recentAlerts: Set<string> = new Set(); // For deduplication

  // Statistics
  private stats = {
    totalAlertsSent: 0,
    totalAlertsDropped: 0,
    totalAlertsDeduplicated: 0,
    alertsByType: new Map<string, number>(),
    alertsByPriority: new Map<string, number>()
  };

  constructor(config: AlertManagerConfig) {
    this.config = config;

    // Initialize SES client
    this.sesClient = new SESClient({
      region: config.awsSesRegion
    });

    // Start cleanup interval (every 5 minutes)
    setInterval(() => this.cleanupOldAlerts(), 5 * 60 * 1000);

    logger.info('AlertManager initialized', {
      emailEnabled: config.emailEnabled,
      recipients: config.emailRecipients,
      maxAlertsPerHour: config.maxAlertsPerHour,
      deduplicationWindowMs: config.deduplicationWindowMs
    });
  }

  /**
   * Send alert notification
   */
  async sendAlert(alert: StateAlert | EventAlert): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    // Check if this is a duplicate (deduplication)
    const alertKey = this.getAlertKey(alert);
    if (this.isDuplicate(alertKey)) {
      this.stats.totalAlertsDeduplicated++;
      logger.debug(`Alert deduplicated: ${alertKey}`);
      return false;
    }

    // Check rate limits
    if (this.isRateLimited(alert)) {
      this.stats.totalAlertsDropped++;
      logger.warn(`Alert dropped due to rate limit: ${alert.type}`, {
        priority: alert.priority,
        message: alert.message
      });
      return false;
    }

    // Record alert
    this.recordAlert(alert);

    // Send via configured channels
    let sent = false;

    if (this.config.emailEnabled) {
      try {
        await this.sendEmailAlert(alert);
        sent = true;
        this.stats.totalAlertsSent++;
      } catch (error) {
        logger.error('Failed to send email alert', { error, alert });
      }
    }

    // Update statistics
    const typeKey = alert.type;
    this.stats.alertsByType.set(typeKey, (this.stats.alertsByType.get(typeKey) || 0) + 1);
    this.stats.alertsByPriority.set(alert.priority, (this.stats.alertsByPriority.get(alert.priority) || 0) + 1);

    return sent;
  }

  /**
   * Send email alert via AWS SES
   */
  private async sendEmailAlert(alert: StateAlert | EventAlert): Promise<void> {
    const subject = this.buildEmailSubject(alert);
    const body = this.buildEmailBody(alert);

    const command = new SendEmailCommand({
      Source: this.config.emailFrom,
      Destination: {
        ToAddresses: this.config.emailRecipients
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8'
        },
        Body: {
          Html: {
            Data: body,
            Charset: 'UTF-8'
          }
        }
      }
    });

    await this.sesClient.send(command);
    logger.info(`Email alert sent: ${subject}`, {
      recipients: this.config.emailRecipients
    });
  }

  /**
   * Build email subject line
   */
  private buildEmailSubject(alert: StateAlert | EventAlert): string {
    const priorityPrefix = {
      critical: '🚨 CRITICAL',
      high: '⚠️  HIGH',
      medium: '📊 MEDIUM'
    };

    const prefix = priorityPrefix[alert.priority];
    return `${prefix}: Hokusai AMM Alert - ${alert.type.replace(/_/g, ' ').toUpperCase()}`;
  }

  /**
   * Build HTML email body
   */
  private buildEmailBody(alert: StateAlert | EventAlert): string {
    const priorityColor = {
      critical: '#DC2626',
      high: '#EA580C',
      medium: '#2563EB'
    };

    const color = priorityColor[alert.priority];
    const timestamp = new Date().toISOString();

    let detailsHtml = '';

    // Build details based on alert type
    if ('poolAddress' in alert) {
      // StateAlert
      detailsHtml = this.buildStateAlertDetails(alert as StateAlert);
    } else {
      // EventAlert
      detailsHtml = this.buildEventAlertDetails(alert as EventAlert);
    }

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937; margin: 0; padding: 0; background-color: #f3f4f6; }
    .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .header { background: ${color}; color: white; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
    .content { padding: 24px; }
    .alert-info { background: #f9fafb; border-left: 4px solid ${color}; padding: 16px; margin: 16px 0; border-radius: 4px; }
    .alert-info h2 { margin: 0 0 12px 0; font-size: 18px; color: ${color}; }
    .alert-info p { margin: 8px 0; color: #4b5563; }
    .details { background: #f9fafb; padding: 16px; border-radius: 4px; margin: 16px 0; }
    .details h3 { margin: 0 0 12px 0; font-size: 16px; color: #374151; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { font-weight: 600; color: #6b7280; }
    .detail-value { color: #1f2937; font-family: monospace; }
    .footer { background: #f9fafb; padding: 16px 24px; text-align: center; font-size: 14px; color: #6b7280; border-top: 1px solid #e5e7eb; }
    .button { display: inline-block; background: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0; font-weight: 600; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Hokusai AMM Alert</h1>
    </div>

    <div class="content">
      <div class="alert-info">
        <h2>${alert.type.replace(/_/g, ' ').toUpperCase()}</h2>
        <p><strong>Priority:</strong> ${alert.priority.toUpperCase()}</p>
        <p><strong>Message:</strong> ${alert.message}</p>
        <p><strong>Time:</strong> ${timestamp}</p>
      </div>

      ${detailsHtml}

      <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">
        This is an automated alert from the Hokusai AMM monitoring system.
      </p>
    </div>

    <div class="footer">
      <p>Hokusai AMM Monitoring System</p>
      <p>Generated at ${timestamp}</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Build details for state alerts
   */
  private buildStateAlertDetails(alert: StateAlert): string {
    const { currentState, previousState } = alert;

    return `
      <div class="details">
        <h3>Pool Information</h3>
        <div class="detail-row">
          <span class="detail-label">Pool Address:</span>
          <span class="detail-value">${alert.poolAddress}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Model ID:</span>
          <span class="detail-value">${alert.modelId}</span>
        </div>
      </div>

      <div class="details">
        <h3>Current State</h3>
        <div class="detail-row">
          <span class="detail-label">Reserve (USD):</span>
          <span class="detail-value">$${currentState.reserveUSD.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Spot Price (USD):</span>
          <span class="detail-value">$${currentState.priceUSD.toFixed(6)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Market Cap (USD):</span>
          <span class="detail-value">$${currentState.marketCapUSD.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Token Supply:</span>
          <span class="detail-value">${currentState.tokenSupply.toString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Paused:</span>
          <span class="detail-value">${currentState.paused ? 'YES ⚠️' : 'No'}</span>
        </div>
      </div>

      ${previousState ? `
        <div class="details">
          <h3>Previous State (for comparison)</h3>
          <div class="detail-row">
            <span class="detail-label">Reserve (USD):</span>
            <span class="detail-value">$${previousState.reserveUSD.toLocaleString()}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Spot Price (USD):</span>
            <span class="detail-value">$${previousState.priceUSD.toFixed(6)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Change:</span>
            <span class="detail-value">${this.calculateChangePercent(previousState.reserveUSD, currentState.reserveUSD)}%</span>
          </div>
        </div>
      ` : ''}
    `;
  }

  /**
   * Build details for event alerts
   */
  private buildEventAlertDetails(alert: EventAlert): string {
    const event = alert.event;

    if ('reserveAmount' in event) {
      // TradeEvent
      const trade = event as TradeEvent;
      return `
        <div class="details">
          <h3>Trade Details</h3>
          <div class="detail-row">
            <span class="detail-label">Type:</span>
            <span class="detail-value">${trade.type.toUpperCase()}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Pool:</span>
            <span class="detail-value">${trade.poolAddress}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Model ID:</span>
            <span class="detail-value">${trade.modelId}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Trader:</span>
            <span class="detail-value">${trade.trader}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Reserve Amount:</span>
            <span class="detail-value">$${trade.reserveAmountUSD.toLocaleString()}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Token Amount:</span>
            <span class="detail-value">${trade.tokenAmountFormatted.toFixed(2)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Fee:</span>
            <span class="detail-value">$${trade.feeAmountUSD.toFixed(2)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Spot Price:</span>
            <span class="detail-value">$${trade.spotPriceUSD.toFixed(6)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Transaction:</span>
            <span class="detail-value"><code>${trade.transactionHash}</code></span>
          </div>
        </div>
      `;
    } else if ('contractAddress' in event) {
      // SecurityEvent
      const security = event as SecurityEvent;
      return `
        <div class="details">
          <h3>Security Event Details</h3>
          <div class="detail-row">
            <span class="detail-label">Event Type:</span>
            <span class="detail-value">${security.type}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Contract:</span>
            <span class="detail-value">${security.contractAddress}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Actor:</span>
            <span class="detail-value">${security.actor}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Transaction:</span>
            <span class="detail-value"><code>${security.transactionHash}</code></span>
          </div>
          ${security.details ? `
            <div class="detail-row">
              <span class="detail-label">Details:</span>
              <span class="detail-value">${JSON.stringify(security.details, null, 2)}</span>
            </div>
          ` : ''}
        </div>
      `;
    } else {
      // FeeEvent
      const fee = event as FeeEvent;
      return `
        <div class="details">
          <h3>Fee Deposit Details</h3>
          <div class="detail-row">
            <span class="detail-label">Pool:</span>
            <span class="detail-value">${fee.poolAddress}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Model ID:</span>
            <span class="detail-value">${fee.modelId}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Amount:</span>
            <span class="detail-value">$${fee.amountUSD.toFixed(2)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">New Reserve:</span>
            <span class="detail-value">$${Number(fee.newReserveBalance) / 1e6}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Transaction:</span>
            <span class="detail-value"><code>${fee.transactionHash}</code></span>
          </div>
        </div>
      `;
    }
  }

  /**
   * Calculate percentage change
   */
  private calculateChangePercent(oldValue: number, newValue: number): string {
    if (oldValue === 0) return 'N/A';
    const change = ((newValue - oldValue) / oldValue) * 100;
    const sign = change > 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}`;
  }

  /**
   * Generate unique key for alert deduplication
   */
  private getAlertKey(alert: StateAlert | EventAlert): string {
    if ('poolAddress' in alert) {
      // StateAlert
      return `${alert.type}:${alert.poolAddress}:${alert.priority}`;
    } else {
      // EventAlert
      return `${alert.type}:${alert.priority}:${alert.message}`;
    }
  }

  /**
   * Check if alert is a duplicate within deduplication window
   */
  private isDuplicate(alertKey: string): boolean {
    if (this.recentAlerts.has(alertKey)) {
      return true;
    }

    // Add to recent alerts with expiration
    this.recentAlerts.add(alertKey);
    setTimeout(() => {
      this.recentAlerts.delete(alertKey);
    }, this.config.deduplicationWindowMs);

    return false;
  }

  /**
   * Check if alert should be rate limited
   */
  private isRateLimited(alert: StateAlert | EventAlert): boolean {
    const alertType = alert.type;
    const now = Date.now();

    // Get or create history for this alert type
    if (!this.alertHistory.has(alertType)) {
      this.alertHistory.set(alertType, []);
    }

    const history = this.alertHistory.get(alertType)!;

    // Count alerts in last hour
    const oneHourAgo = now - (60 * 60 * 1000);
    const alertsLastHour = history.filter(r => r.timestamp >= oneHourAgo).length;

    if (alertsLastHour >= this.config.maxAlertsPerHour) {
      return true;
    }

    // Count alerts in last day
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const alertsLastDay = history.filter(r => r.timestamp >= oneDayAgo).length;

    if (alertsLastDay >= this.config.maxAlertsPerDay) {
      return true;
    }

    return false;
  }

  /**
   * Record alert in history for rate limiting
   */
  private recordAlert(alert: StateAlert | EventAlert): void {
    const alertType = alert.type;
    const now = Date.now();

    if (!this.alertHistory.has(alertType)) {
      this.alertHistory.set(alertType, []);
    }

    const history = this.alertHistory.get(alertType)!;
    history.push({
      alert,
      timestamp: now,
      sentCount: 1,
      lastSentTime: now
    });
  }

  /**
   * Clean up old alerts from history
   */
  private cleanupOldAlerts(): void {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // Keep 24 hours

    for (const [type, history] of this.alertHistory.entries()) {
      const filtered = history.filter(r => r.timestamp >= cutoff);
      this.alertHistory.set(type, filtered);
    }

    logger.debug('Alert history cleanup completed', {
      totalTypes: this.alertHistory.size,
      totalRecords: Array.from(this.alertHistory.values()).reduce((sum, h) => sum + h.length, 0)
    });
  }

  /**
   * Get alert statistics
   */
  getStats() {
    return {
      ...this.stats,
      alertsByType: Object.fromEntries(this.stats.alertsByType),
      alertsByPriority: Object.fromEntries(this.stats.alertsByPriority),
      alertHistorySize: Array.from(this.alertHistory.values()).reduce((sum, h) => sum + h.length, 0),
      recentAlertsSize: this.recentAlerts.size
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalAlertsSent: 0,
      totalAlertsDropped: 0,
      totalAlertsDeduplicated: 0,
      alertsByType: new Map<string, number>(),
      alertsByPriority: new Map<string, number>()
    };
  }
}
