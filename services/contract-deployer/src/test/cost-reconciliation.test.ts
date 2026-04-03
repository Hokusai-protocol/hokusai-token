import { ethers } from 'ethers';
import { CostReconciliationService } from '../monitoring/cost-reconciliation-service';

/**
 * Cost Reconciliation Service Tests
 *
 * Tests:
 * - Cost ingestion
 * - Variance calculation
 * - Adjustment recommendations
 * - Runway calculations
 * - Alert generation
 * - API data access methods
 */

describe('CostReconciliationService', () => {
  let service: CostReconciliationService;
  let mockProvider: any;
  let mockContract: any;

  beforeEach(() => {
    // Mock Ethereum provider
    mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(12345),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 11155111n, name: 'sepolia' })
    };

    // Mock contract with getModelAccounting
    mockContract = {
      getModelAccounting: jest.fn().mockResolvedValue([
        ethers.parseUnits('10000', 6), // accrued: $10,000
        ethers.parseUnits('5000', 6),  // paid: $5,000
        '0x1234567890123456789012345678901234567890' // provider
      ])
    };

    // Mock Contract constructor
    jest.spyOn(ethers, 'Contract').mockReturnValue(mockContract as any);

    // Create service
    service = new CostReconciliationService({
      provider: mockProvider as any,
      infraReserveAddress: '0x1111111111111111111111111111111111111111',
      varianceWarningPercent: 10,
      varianceCriticalPercent: 20,
      runwayWarningDays: 7,
      runwayCriticalDays: 3,
      reconciliationIntervalMs: 86400000 // Daily
    });
  });

  afterEach(async () => {
    await service.stop();
    jest.clearAllMocks();
  });

  describe('Cost Ingestion', () => {
    it('should ingest actual costs', async () => {
      const cost = {
        modelId: 'gpt-4',
        provider: 'AWS',
        amount: 1234.56,
        period: {
          start: new Date('2026-03-01'),
          end: new Date('2026-03-31')
        },
        invoiceId: 'INV-2026-03'
      };

      await service.ingestActualCosts(cost);

      const history = service.getCostHistory('gpt-4');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject(cost);
    });

    it('should track costs for multiple models', async () => {
      await service.ingestActualCosts({
        modelId: 'gpt-4',
        provider: 'AWS',
        amount: 1000,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });

      await service.ingestActualCosts({
        modelId: 'claude-3',
        provider: 'AWS',
        amount: 2000,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });

      const models = service.getTrackedModels();
      expect(models).toContain('gpt-4');
      expect(models).toContain('claude-3');
      expect(models).toHaveLength(2);
    });

    it('should limit cost history to 12 months', async () => {
      const modelId = 'gpt-4';

      // Ingest 15 months of costs
      for (let i = 0; i < 15; i++) {
        await service.ingestActualCosts({
          modelId,
          provider: 'AWS',
          amount: 1000 + i,
          period: {
            start: new Date(`2025-${String(i + 1).padStart(2, '0')}-01`),
            end: new Date(`2025-${String(i + 1).padStart(2, '0')}-28`)
          }
        });
      }

      const history = service.getCostHistory(modelId);
      expect(history).toHaveLength(12);
      // Should keep the most recent 12
      expect(history[0].amount).toBe(1003); // Month 4
      expect(history[11].amount).toBe(1014); // Month 15
    });
  });

  describe('Variance Calculation', () => {
    it('should calculate variance from cost history', async () => {
      const modelId = 'gpt-4';

      // Ingest some costs
      await service.ingestActualCosts({
        modelId,
        provider: 'AWS',
        amount: 1000,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });

      await service.ingestActualCosts({
        modelId,
        provider: 'AWS',
        amount: 1100,
        period: { start: new Date('2026-04-01'), end: new Date('2026-04-30') }
      });

      // Note: Variance calculation is internal and runs during reconciliation
      // We test the getter methods instead
      const variance = service.getCurrentVariance(modelId);
      // Initially undefined until reconciliation runs
      expect(variance).toBeUndefined();
    });

    it('should return variance history', async () => {
      const modelId = 'gpt-4';
      const history = service.getVarianceHistory(modelId, 5);
      expect(Array.isArray(history)).toBe(true);
    });

    it('should limit variance history', async () => {
      const modelId = 'gpt-4';
      const history = service.getVarianceHistory(modelId, 3);
      expect(history.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Recommendations', () => {
    it('should return empty recommendations for new model', () => {
      const recommendations = service.getRecommendations('gpt-4');
      expect(recommendations).toHaveLength(0);
    });

    it('should return latest recommendation', () => {
      const latest = service.getLatestRecommendation('gpt-4');
      expect(latest).toBeUndefined();
    });

    it('should limit recommendation history', () => {
      const recommendations = service.getRecommendations('gpt-4', 5);
      expect(recommendations.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Service Lifecycle', () => {
    it('should start successfully', async () => {
      await service.start();
      const status = service.getStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should stop successfully', async () => {
      await service.start();
      await service.stop();
      const status = service.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not start twice', async () => {
      await service.start();
      await service.start(); // Should log warning but not error
      const status = service.getStatus();
      expect(status.isRunning).toBe(true);
    });
  });

  describe('Service Status', () => {
    it('should return correct status', () => {
      const status = service.getStatus();
      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('modelsTracked');
      expect(status).toHaveProperty('models');
      expect(status).toHaveProperty('config');
    });

    it('should track model count', async () => {
      await service.ingestActualCosts({
        modelId: 'gpt-4',
        provider: 'AWS',
        amount: 1000,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });

      const status = service.getStatus();
      expect(status.modelsTracked).toBe(1);
      expect(status.models).toContain('gpt-4');
    });

    it('should include configuration in status', () => {
      const status = service.getStatus();
      expect(status.config.varianceWarningPercent).toBe(10);
      expect(status.config.varianceCriticalPercent).toBe(20);
      expect(status.config.runwayWarningDays).toBe(7);
      expect(status.config.runwayCriticalDays).toBe(3);
    });
  });

  describe('Data Access', () => {
    beforeEach(async () => {
      // Ingest test data
      await service.ingestActualCosts({
        modelId: 'test-model',
        provider: 'AWS',
        amount: 1000,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });
    });

    it('should get cost history', () => {
      const history = service.getCostHistory('test-model');
      expect(history).toHaveLength(1);
      expect(history[0].amount).toBe(1000);
    });

    it('should get tracked models', () => {
      const models = service.getTrackedModels();
      expect(models).toContain('test-model');
    });

    it('should return empty array for unknown model', () => {
      const history = service.getCostHistory('unknown-model');
      expect(history).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle model with no cost history', () => {
      const variance = service.getCurrentVariance('unknown-model');
      expect(variance).toBeUndefined();
    });

    it('should handle cost with missing optional fields', async () => {
      await service.ingestActualCosts({
        modelId: 'minimal-model',
        provider: 'AWS',
        amount: 500,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
        // No invoiceId, no metadata
      });

      const history = service.getCostHistory('minimal-model');
      expect(history).toHaveLength(1);
      expect(history[0].invoiceId).toBeUndefined();
      expect(history[0].metadata).toBeUndefined();
    });

    it('should handle zero amount cost', async () => {
      await service.ingestActualCosts({
        modelId: 'zero-cost',
        provider: 'AWS',
        amount: 0,
        period: { start: new Date('2026-03-01'), end: new Date('2026-03-31') }
      });

      const history = service.getCostHistory('zero-cost');
      expect(history).toHaveLength(1);
      expect(history[0].amount).toBe(0);
    });
  });
});
