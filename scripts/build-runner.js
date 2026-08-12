import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dockerfilePath = join(__dirname, '..', 'docker', 'Dockerfile.runner');

console.log('Building cloudeeeide-runner:latest...');
try {
  execSync(`docker build -t cloudeeeide-runner:latest -f "${dockerfilePath}" .`, { 
    stdio: 'inherit',
    cwd: join(__dirname, '..')
  });
  console.log('Successfully built cloudeeeide-runner:latest');
} catch (err) {
  console.error('Failed to build runner image:', err);
  process.exit(1);
}
