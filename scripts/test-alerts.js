/**
 * Test Alert Scenarios
 *
 * Run different test alerts to verify the monitoring system
 */

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
require('dotenv').config();

const emailFrom = process.env.ALERT_EMAIL_FROM || 'tim@hokus.ai';
const emailTo = process.env.ALERT_EMAIL_TO || 'me@timogilvie.com';
const awsRegion = process.env.AWS_REGION || 'us-east-1';

const sesClient = new SESClient({ region: awsRegion });

// Alert scenarios
const scenarios = {
  'reserve-drop': {
    title: '⚠️ Reserve Drop Alert',
    priority: 'HIGH',
    description: 'Pool reserve dropped below threshold',
    details: {
      pool: 'model-conservative-001',
      currentReserve: '$8,500 USDC',
      previousReserve: '$10,000 USDC',
      dropPercentage: '15%',
      threshold: '10%'
    }
  },
  'large-trade': {
    title: '📊 Large Trade Detected',
    priority: 'MEDIUM',
    description: 'Unusually large trade detected',
    details: {
      pool: 'model-aggressive-002',
      tradeType: 'BUY',
      tradeSize: '$15,000 USDC',
      buyer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      priceImpact: '3.2%'
    }
  },
  'pool-paused': {
    title: '🛑 Pool Paused',
    priority: 'CRITICAL',
    description: 'AMM pool has been paused',
    details: {
      pool: 'model-balanced-003',
      pausedBy: '0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B',
      timestamp: new Date().toISOString(),
      reason: 'Manual pause by owner'
    }
  },
  'high-volume': {
    title: '📈 High Trading Volume',
    priority: 'LOW',
    description: 'Unusual trading volume detected',
    details: {
      pool: 'model-conservative-001',
      trades24h: 156,
      volume24h: '$45,000 USDC',
      averageTradeSize: '$288 USDC',
      threshold: '100 trades/day'
    }
  },
  'price-slippage': {
    title: '💱 High Price Slippage',
    priority: 'HIGH',
    description: 'Price slippage exceeded threshold',
    details: {
      pool: 'model-aggressive-002',
      previousPrice: '$0.0120',
      currentPrice: '$0.0105',
      slippage: '12.5%',
      threshold: '5%',
      timeWindow: '5 minutes'
    }
  }
};

async function sendAlert(scenarioKey) {
  const scenario = scenarios[scenarioKey];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioKey}`);
    console.log(`Available scenarios: ${Object.keys(scenarios).join(', ')}`);
    return false;
  }

  const subject = `${scenario.title} - Hokusai AMM Monitoring [${scenario.priority}]`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: ${getPriorityColor(scenario.priority)}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f7fafc; padding: 20px; border: 1px solid #e2e8f0; }
    .alert-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
    .details { background: white; padding: 15px; margin: 15px 0; border-radius: 4px; }
    .footer { background: #2d3748; color: #a0aec0; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">${scenario.title}</h1>
      <p style="margin: 5px 0 0 0; opacity: 0.9;">Priority: ${scenario.priority}</p>
    </div>
    <div class="content">
      <div class="alert-box">
        <strong>⚠️ Alert Description</strong>
        <p>${scenario.description}</p>
      </div>
      <h3>Details</h3>
      <div class="details">
        ${Object.entries(scenario.details).map(([key, value]) => `
          <p><strong>${formatKey(key)}:</strong> ${value}</p>
        `).join('')}
      </div>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
    </div>
    <div class="footer">
      <p style="margin: 5px 0;">Hokusai AMM Monitoring - Testnet</p>
    </div>
  </div>
</body>
</html>
  `;

  const textBody = `
${scenario.title}
Priority: ${scenario.priority}

${scenario.description}

Details:
${Object.entries(scenario.details).map(([key, value]) => `${formatKey(key)}: ${value}`).join('\n')}

Timestamp: ${new Date().toISOString()}

---
Hokusai AMM Monitoring - Testnet
  `;

  try {
    console.log(`\n📧 Sending ${scenarioKey} alert...`);

    const command = new SendEmailCommand({
      Source: emailFrom,
      Destination: { ToAddresses: [emailTo] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' }
        }
      }
    });

    const response = await sesClient.send(command);
    console.log(`✅ Alert sent! Message ID: ${response.MessageId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send alert:`, error.message);
    return false;
  }
}

function getPriorityColor(priority) {
  const colors = {
    'CRITICAL': 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
    'HIGH': 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    'MEDIUM': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'LOW': 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
  };
  return colors[priority] || colors['MEDIUM'];
}

function formatKey(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .replace(/24h/, '24h')
    .trim();
}

// CLI handling
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('\n🧪 Hokusai Alert Test Script\n');
    console.log('Usage: node test-alerts.js [scenario] [scenario2...]\n');
    console.log('Available scenarios:');
    Object.keys(scenarios).forEach(key => {
      console.log(`  - ${key}: ${scenarios[key].description}`);
    });
    console.log('\nExamples:');
    console.log('  node test-alerts.js reserve-drop');
    console.log('  node test-alerts.js large-trade high-volume');
    console.log('  node test-alerts.js all\n');
    return;
  }

  const toTest = args[0] === 'all' ? Object.keys(scenarios) : args;

  console.log(`\n📬 Sending to: ${emailTo}`);
  console.log(`📤 From: ${emailFrom}\n`);

  let sent = 0;
  let failed = 0;

  for (const scenario of toTest) {
    const success = await sendAlert(scenario);
    if (success) sent++;
    else failed++;

    // Small delay between emails
    if (toTest.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n✅ Sent: ${sent}`);
  if (failed > 0) console.log(`❌ Failed: ${failed}`);
  console.log(`\n📬 Check your inbox at ${emailTo}\n`);
}

main().catch(console.error);
