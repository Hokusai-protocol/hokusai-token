#!/usr/bin/env node
/**
 * CSV Cost Ingestion Script
 *
 * Ingests infrastructure costs from CSV file and submits to reconciliation service.
 *
 * CSV Format:
 * modelId,provider,amount,periodStart,periodEnd,invoiceId
 * gpt-4,AWS,1234.56,2026-03-01,2026-03-31,INV-2026-03
 *
 * Usage:
 *   npx tsx src/scripts/ingest-costs-csv.ts <csv-file> [--dry-run]
 */

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import fetch from 'node-fetch';

interface CsvRow {
  modelId: string;
  provider: string;
  amount: string;
  periodStart: string;
  periodEnd: string;
  invoiceId?: string;
}

interface IngestConfig {
  apiUrl: string;
  dryRun: boolean;
}

async function ingestCosts(csvPath: string, config: IngestConfig): Promise<void> {
  console.log(`Reading CSV from: ${csvPath}`);

  // Read and parse CSV
  const csvContent = readFileSync(csvPath, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];

  console.log(`Found ${records.length} cost records`);

  if (config.dryRun) {
    console.log('\n=== DRY RUN MODE ===');
    records.forEach((record, i) => {
      console.log(`\n[${i + 1}] ${record.modelId}`);
      console.log(`  Provider: ${record.provider}`);
      console.log(`  Amount: $${parseFloat(record.amount).toFixed(2)}`);
      console.log(`  Period: ${record.periodStart} to ${record.periodEnd}`);
      if (record.invoiceId) {
        console.log(`  Invoice: ${record.invoiceId}`);
      }
    });
    console.log('\n=== END DRY RUN ===\n');
    return;
  }

  // Ingest each record
  let successCount = 0;
  let errorCount = 0;

  for (const record of records) {
    try {
      const payload = {
        provider: record.provider,
        amount: parseFloat(record.amount),
        period: {
          start: new Date(record.periodStart).toISOString(),
          end: new Date(record.periodEnd).toISOString()
        },
        invoiceId: record.invoiceId || undefined
      };

      console.log(`Ingesting costs for ${record.modelId}...`);

      const response = await fetch(
        `${config.apiUrl}/api/reconciliation/${encodeURIComponent(record.modelId)}/costs`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        let errorMessage: string;
        try {
          const error = await response.json();
          errorMessage = `API error: ${JSON.stringify(error)}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log(`  ✓ Success: ${result.data.message}`);
      successCount++;

    } catch (error) {
      console.error(`  ✗ Error ingesting ${record.modelId}:`, error instanceof Error ? error.message : error);
      errorCount++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total records: ${records.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
CSV Cost Ingestion Script

Usage:
  npx tsx src/scripts/ingest-costs-csv.ts <csv-file> [options]

Options:
  --dry-run     Preview records without submitting
  --api-url     API URL (default: http://localhost:8002)
  --help, -h    Show this help

CSV Format:
  modelId,provider,amount,periodStart,periodEnd,invoiceId
  gpt-4,AWS,1234.56,2026-03-01,2026-03-31,INV-2026-03

Environment:
  RECONCILIATION_API_URL  Override default API URL
    `);
    process.exit(0);
  }

  const csvPath = args[0];
  const dryRun = args.includes('--dry-run');
  const apiUrlArg = args.find(arg => arg.startsWith('--api-url='));
  const apiUrl = apiUrlArg
    ? apiUrlArg.split('=')[1]
    : (process.env.RECONCILIATION_API_URL || 'http://localhost:8002');

  const config: IngestConfig = {
    apiUrl,
    dryRun
  };

  console.log(`API URL: ${config.apiUrl}`);
  console.log(`Dry run: ${config.dryRun ? 'YES' : 'NO'}\n`);

  try {
    await ingestCosts(csvPath, config);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
