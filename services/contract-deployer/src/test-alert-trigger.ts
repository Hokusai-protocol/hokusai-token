/**
 * Test Alert Trigger Script
 *
 * Sends a test alert via AWS SES to verify the alert system is working
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import dotenv from 'dotenv';

dotenv.config();

async function sendTestAlert() {
  console.log('🧪 Testing Alert System...\n');

  // Configuration
  const emailFrom = process.env.ALERT_EMAIL_FROM || 'tim@hokus.ai';
  const emailTo = process.env.ALERT_EMAIL_TO || 'me@timogilvie.com';
  const awsRegion = process.env.AWS_REGION || 'us-east-1';

  console.log(`From: ${emailFrom}`);
  console.log(`To: ${emailTo}`);
  console.log(`Region: ${awsRegion}\n`);

  // Create SES client
  const sesClient = new SESClient({ region: awsRegion });

  // Create test alert email
  const subject = '🧪 [TEST] Hokusai AMM Monitoring Alert - Testnet';

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f7fafc; padding: 20px; border: 1px solid #e2e8f0; }
    .alert-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
    .info-box { background: #d1ecf1; border-left: 4px solid #0c5460; padding: 15px; margin: 15px 0; }
    .footer { background: #2d3748; color: #a0aec0; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; }
    .metric { display: inline-block; margin: 10px 20px 10px 0; }
    .metric-label { color: #718096; font-size: 12px; }
    .metric-value { color: #2d3748; font-size: 18px; font-weight: bold; }
    a { color: #667eea; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">🧪 Test Alert</h1>
      <p style="margin: 5px 0 0 0; opacity: 0.9;">Hokusai AMM Monitoring System</p>
    </div>

    <div class="content">
      <div class="alert-box">
        <strong>⚠️ This is a TEST alert</strong>
        <p>This alert was manually triggered to verify the monitoring system is working correctly.</p>
      </div>

      <h3>Alert Details</h3>
      <p>
        <strong>Alert Type:</strong> System Test<br>
        <strong>Priority:</strong> Medium<br>
        <strong>Environment:</strong> Sepolia Testnet<br>
        <strong>Timestamp:</strong> ${new Date().toISOString()}<br>
      </p>

      <h3>Test Scenario</h3>
      <p>This alert simulates a typical monitoring alert that would be sent when a threshold is breached.</p>

      <div class="info-box">
        <strong>ℹ️ Example: Reserve Drop Alert</strong>
        <p>
          <strong>Pool:</strong> model-conservative-001<br>
          <strong>Address:</strong> 0x58565F787C49F09C7Bf33990e7C5B7208580901a<br>
          <strong>Issue:</strong> Reserve balance dropped by 12% in the last hour<br>
          <strong>Current Reserve:</strong> $8,800 USDC<br>
          <strong>Previous Reserve:</strong> $10,000 USDC<br>
          <strong>Threshold:</strong> 10% drop
        </p>
      </div>

      <h3>Monitored Metrics</h3>
      <div>
        <div class="metric">
          <div class="metric-label">Reserve Balance</div>
          <div class="metric-value">$8,800</div>
        </div>
        <div class="metric">
          <div class="metric-label">Spot Price</div>
          <div class="metric-value">$0.0088</div>
        </div>
        <div class="metric">
          <div class="metric-label">24h Volume</div>
          <div class="metric-value">$1,200</div>
        </div>
      </div>

      <h3>Action Required</h3>
      <p>✅ <strong>No action needed</strong> - This is a test alert to verify email delivery.</p>

      <p><strong>If this were a real alert:</strong></p>
      <ul>
        <li>Review pool state and recent transactions</li>
        <li>Check for unusual trading activity</li>
        <li>Verify smart contract is not paused</li>
        <li>Monitor for additional alerts</li>
      </ul>
    </div>

    <div class="footer">
      <p style="margin: 5px 0;">Hokusai AMM Monitoring - Testnet</p>
      <p style="margin: 5px 0; font-size: 12px;">
        Service: hokusai-monitor-testnet | Region: us-east-1
      </p>
    </div>
  </div>
</body>
</html>
  `;

  const textBody = `
🧪 TEST ALERT - Hokusai AMM Monitoring

This is a test alert to verify the monitoring system is working correctly.

Alert Details:
- Alert Type: System Test
- Priority: Medium
- Environment: Sepolia Testnet
- Timestamp: ${new Date().toISOString()}

Example Scenario:
Pool: model-conservative-001
Address: 0x58565F787C49F09C7Bf33990e7C5B7208580901a
Issue: Reserve balance dropped by 12% in the last hour
Current Reserve: $8,800 USDC
Previous Reserve: $10,000 USDC
Threshold: 10% drop

Action Required: ✅ No action needed - This is a test alert

---
Hokusai AMM Monitoring - Testnet
Service: hokusai-monitor-testnet | Region: us-east-1
  `;

  try {
    console.log('📧 Sending test alert email...\n');

    const command = new SendEmailCommand({
      Source: emailFrom,
      Destination: {
        ToAddresses: [emailTo]
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8'
        },
        Body: {
          Html: {
            Data: htmlBody,
            Charset: 'UTF-8'
          },
          Text: {
            Data: textBody,
            Charset: 'UTF-8'
          }
        }
      }
    });

    const response = await sesClient.send(command);

    console.log('✅ Test alert sent successfully!');
    console.log(`Message ID: ${response.MessageId}\n`);
    console.log(`📬 Check your inbox at ${emailTo}`);
    console.log('   (Check spam folder if not in inbox)\n');

    return true;
  } catch (error) {
    console.error('❌ Failed to send test alert:', error);
    throw error;
  }
}

// Run the test
sendTestAlert()
  .then(() => {
    console.log('\n✅ Test complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
