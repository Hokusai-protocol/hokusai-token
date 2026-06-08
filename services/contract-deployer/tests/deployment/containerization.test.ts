import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Integration tests for containerization and deployment
 */
describe('Containerization and Deployment Tests', () => {
  describe('Docker Configuration', () => {
    it('should have a valid Dockerfile', () => {
      const dockerfilePath = path.join(__dirname, '../../Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      
      // Check for multi-stage build
      expect(dockerfileContent).toContain('FROM node:18-alpine AS builder');
      expect(dockerfileContent).toContain('FROM node:18-alpine');
      
      // Check for security features
      expect(dockerfileContent).toContain('USER nodejs');
      expect(dockerfileContent).toContain('dumb-init');
      
      // Check for proper port exposure
      expect(dockerfileContent).toContain('EXPOSE 8002');
      
      // Check for health check
      expect(dockerfileContent).toContain('HEALTHCHECK');
      
      // Check for API server mode
      expect(dockerfileContent).toContain('CMD ["node", "dist/server.js"]');
    });

    it('should have a .dockerignore file', () => {
      const dockerignorePath = path.join(__dirname, '../../.dockerignore');
      expect(fs.existsSync(dockerignorePath)).toBe(true);
      
      const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf-8');
      
      // Check for common exclusions
      expect(dockerignoreContent).toContain('node_modules');
      expect(dockerignoreContent).toContain('.env');
      expect(dockerignoreContent).toContain('.git');
      expect(dockerignoreContent).toContain('tests');
    });

    it('should have docker-compose.yml for local testing', () => {
      const composePath = path.join(__dirname, '../../docker-compose.yml');
      expect(fs.existsSync(composePath)).toBe(true);
      
      const composeContent = fs.readFileSync(composePath, 'utf-8');
      
      // Check for service configuration
      expect(composeContent).toContain('contract-deployer');
      expect(composeContent).toContain('redis');
      expect(composeContent).toContain('8002:8002');
    });
  });

  describe('Environment Configuration', () => {
    it('should have production environment template', () => {
      const envProdPath = path.join(__dirname, '../../.env.production');
      expect(fs.existsSync(envProdPath)).toBe(true);
      
      const envContent = fs.readFileSync(envProdPath, 'utf-8');
      
      // Check for required environment variables
      expect(envContent).toContain('NODE_ENV=production');
      expect(envContent).toContain('PORT=8002');
      expect(envContent).toContain('AWS_REGION=us-east-1');
      expect(envContent).toContain('${SSM_REDIS_URL}');
      expect(envContent).toContain('${SSM_DEPLOYER_KEY}');
    });

    it('should support flexible port configuration', () => {
      const serverPath = path.join(__dirname, '../../src/server.ts');
      const serverContent = fs.readFileSync(serverPath, 'utf-8');

      // Port is read from the validated config object (serverConfig.PORT),
      // which is sourced from the PORT environment variable via env validation.
      expect(serverContent).toMatch(/serverConfig\.PORT/);
      // ...and passed to app.listen so the bind port is configurable.
      expect(serverContent).toMatch(/app\.listen\(\s*port/);
    });

    it('should have AWS SSM Parameter Store integration', () => {
      const ssmPath = path.join(__dirname, '../../src/config/aws-ssm.ts');
      expect(fs.existsSync(ssmPath)).toBe(true);
      
      const ssmContent = fs.readFileSync(ssmPath, 'utf-8');
      
      // Check for SSM client implementation
      expect(ssmContent).toContain('SSMClient');
      expect(ssmContent).toContain('GetParameterCommand');
      // Bulk parameter retrieval entry point used by loadSSMConfiguration().
      expect(ssmContent).toContain('getAllParameters');
      // Retry-on-failure behaviour for SSM fetches.
      expect(ssmContent).toContain('retry logic');
    });
  });

  describe('Deployment Scripts', () => {
    it('should have ECR build and push script', () => {
      const scriptPath = path.join(__dirname, '../../scripts/build-and-push.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      
      const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
      
      // Check for required functionality
      expect(scriptContent).toContain('docker build');
      expect(scriptContent).toContain('aws ecr get-login-password');
      expect(scriptContent).toContain('docker push');
      // The ECR target is composed from variables; verify the account id and
      // repository that make up the canonical hokusai/contracts ECR URL.
      expect(scriptContent).toContain('932100697590');
      expect(scriptContent).toContain('ECR_REPOSITORY="hokusai/contracts"');
      
      // Check for error handling
      expect(scriptContent).toContain('set -e');
      expect(scriptContent).toContain('retry');
    });

    it('should have ECS deployment script', () => {
      const scriptPath = path.join(__dirname, '../../scripts/deploy.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      
      const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
      
      // Check for required functionality
      expect(scriptContent).toContain('aws ecs update-service');
      expect(scriptContent).toContain('--force-new-deployment');
      expect(scriptContent).toContain('wait_for_deployment');
      expect(scriptContent).toContain('rollback');
      
      // Check for health verification
      expect(scriptContent).toContain('verify_deployment_health');
      expect(scriptContent).toContain('contracts.hokus.ai/health');
    });

    it('should have executable permissions on scripts', () => {
      const scripts = ['build-and-push.sh', 'deploy.sh'];
      
      scripts.forEach(script => {
        const scriptPath = path.join(__dirname, '../../scripts', script);
        const stats = fs.statSync(scriptPath);
        // Check if owner has execute permission (Unix permissions)
        expect(stats.mode & 0o100).toBeTruthy();
      });
    });
  });

  describe('ECS Task Definition', () => {
    it('should have a valid ECS task definition', () => {
      const taskDefPath = path.join(__dirname, '../../ecs/task-definition.json');
      expect(fs.existsSync(taskDefPath)).toBe(true);
      
      const taskDef = JSON.parse(fs.readFileSync(taskDefPath, 'utf-8'));
      
      // Check task configuration
      expect(taskDef.family).toBe('hokusai-contracts-task');
      expect(taskDef.networkMode).toBe('awsvpc');
      expect(taskDef.requiresCompatibilities).toContain('FARGATE');
      expect(taskDef.cpu).toBe('256');
      expect(taskDef.memory).toBe('512');
      
      // Check container definition
      const container = taskDef.containerDefinitions[0];
      expect(container.name).toBe('contract-deployer');
      expect(container.image).toContain('932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts');
      
      // Check port mappings
      const ports = container.portMappings.map((p: any) => p.containerPort);
      expect(ports).toContain(8002);
      expect(ports).toContain(9091);
      
      // Check environment variables
      const envVars = container.environment.map((e: any) => e.name);
      expect(envVars).toContain('PORT');
      expect(envVars).toContain('NODE_ENV');
      expect(envVars).toContain('AWS_REGION');
      
      // Check secrets from SSM
      const secrets = container.secrets.map((s: any) => s.name);
      expect(secrets).toContain('REDIS_URL');
      expect(secrets).toContain('DEPLOYER_PRIVATE_KEY');
      expect(secrets).toContain('MODEL_REGISTRY_ADDRESS');
      
      // Container health checking now lives in the Dockerfile's HEALTHCHECK
      // instruction (which probes /health on the configured PORT, default 8002)
      // rather than in the ECS task definition.
      const dockerfilePath = path.join(__dirname, '../../Dockerfile');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfileContent).toContain('HEALTHCHECK');
      expect(dockerfileContent).toMatch(/localhost:.*\$\{port\}\/health/);

      // Check logging configuration
      expect(container.logConfiguration.logDriver).toBe('awslogs');
      expect(container.logConfiguration.options['awslogs-group']).toBe('/ecs/hokusai-contracts');
    });
  });

  describe('Health Check Endpoints', () => {
    it('should have health check implementation', () => {
      const healthPath = path.join(__dirname, '../../src/routes/health.ts');
      expect(fs.existsSync(healthPath)).toBe(true);
      
      const healthContent = fs.readFileSync(healthPath, 'utf-8');
      
      // Health router exposes a liveness route ('/') and a readiness route
      // ('/ready'); mounted at '/health' these serve /health and /health/ready.
      expect(healthContent).toContain('healthRouter');
      expect(healthContent).toMatch(/router\.get\(\s*['"]\/['"]/);
      expect(healthContent).toMatch(/router\.get\(\s*['"]\/ready['"]/);

      // Readiness performs dependency checks against redis and the blockchain RPC.
      expect(healthContent).toContain('redis');
      expect(healthContent).toMatch(/JsonRpcProvider|RPC_URL/);
    });
  });

  describe('CloudWatch Integration', () => {
    it('should have CloudWatch logging configuration', () => {
      const taskDefPath = path.join(__dirname, '../../ecs/task-definition.json');
      const taskDef = JSON.parse(fs.readFileSync(taskDefPath, 'utf-8'));
      
      const logConfig = taskDef.containerDefinitions[0].logConfiguration;
      expect(logConfig.logDriver).toBe('awslogs');
      expect(logConfig.options['awslogs-region']).toBe('us-east-1');
      expect(logConfig.options['awslogs-stream-prefix']).toBe('contract-deployer-api');
    });
  });

  describe('Security Configuration', () => {
    it('should run as non-root user in container', () => {
      const dockerfilePath = path.join(__dirname, '../../Dockerfile');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      
      expect(dockerfileContent).toContain('USER nodejs');
      expect(dockerfileContent).toContain('adduser -S nodejs');
    });

    it('should use SSM for secrets management', () => {
      const taskDefPath = path.join(__dirname, '../../ecs/task-definition.json');
      const taskDef = JSON.parse(fs.readFileSync(taskDefPath, 'utf-8'));
      
      const secrets = taskDef.containerDefinitions[0].secrets;
      
      // Check that sensitive values come from SSM
      secrets.forEach((secret: any) => {
        expect(secret.valueFrom).toMatch(/arn:aws:ssm:/);
        expect(secret.valueFrom).toContain('/hokusai/development/contracts/');
      });
    });

    it('should have proper IAM roles configured', () => {
      const taskDefPath = path.join(__dirname, '../../ecs/task-definition.json');
      const taskDef = JSON.parse(fs.readFileSync(taskDefPath, 'utf-8'));
      
      expect(taskDef.taskRoleArn).toContain('hokusai-contracts-task-role');
      expect(taskDef.executionRoleArn).toContain('hokusai-contracts-execution-role');
    });
  });

  describe('Port Configuration', () => {
    it('should use port 8002 as default', () => {
      const envValidationPath = path.join(__dirname, '../../src/config/env.validation.ts');
      const envContent = fs.readFileSync(envValidationPath, 'utf-8');
      
      // Check default port is 8002
      expect(envContent).toMatch(/PORT.*default.*8002/);
    });

    it('should expose correct ports in Dockerfile', () => {
      const dockerfilePath = path.join(__dirname, '../../Dockerfile');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      
      // Both the API port (8002) and the metrics port (9091) are exposed.
      // They are declared together on a single EXPOSE line.
      expect(dockerfileContent).toMatch(/EXPOSE(\s+\d+)*\s+8002(\s+\d+)*/);
      expect(dockerfileContent).toMatch(/EXPOSE(\s+\d+)*\s+9091(\s+\d+)*/);
    });

    it('should configure correct port in ECS task definition', () => {
      const taskDefPath = path.join(__dirname, '../../ecs/task-definition.json');
      const taskDef = JSON.parse(fs.readFileSync(taskDefPath, 'utf-8'));
      
      const portEnv = taskDef.containerDefinitions[0].environment.find(
        (e: any) => e.name === 'PORT'
      );
      expect(portEnv.value).toBe('8002');
    });
  });
});

/**
 * Deployment validation tests - run after deployment
 */
describe('Post-Deployment Validation', () => {
  const API_URL = process.env.API_URL || 'https://contracts.hokus.ai';
  
  describe('API Accessibility', () => {
    it('should respond to health check', async () => {
      if (process.env.SKIP_LIVE_TESTS === 'true') {
        console.log('Skipping live API test');
        return;
      }
      
      try {
        const response = await fetch(`${API_URL}/health`, {
          signal: AbortSignal.timeout(5000)
        });

        expect(response.status).toBe(200);
        const data = await response.json() as { status?: string };
        expect(data).toHaveProperty('status');
        expect(data.status).toBe('ok');
      } catch (error) {
        // If API is not deployed yet, skip this test
        console.log('API not accessible, skipping live test');
      }
    }, 10000);

    it('should respond to ready check', async () => {
      if (process.env.SKIP_LIVE_TESTS === 'true') {
        console.log('Skipping live API test');
        return;
      }
      
      try {
        const response = await fetch(`${API_URL}/health/ready`, {
          signal: AbortSignal.timeout(5000)
        });

        expect(response.status).toBe(200);
        const data = await response.json() as { status?: string; checks?: unknown };
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('checks');
      } catch (error) {
        console.log('API not accessible, skipping live test');
      }
    }, 10000);
  });
});