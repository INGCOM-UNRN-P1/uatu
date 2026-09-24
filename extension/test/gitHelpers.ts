import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { tmpDir } from './helpers';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Estudiante',
      GIT_AUTHOR_EMAIL: 'e@example.com',
      GIT_COMMITTER_NAME: 'Estudiante',
      GIT_COMMITTER_EMAIL: 'e@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

/** Crea un repositorio con un commit en main y un remoto bare "origin". */
export function makeRepo(): { repo: string; remote: string } {
  const base = tmpDir('uatu-git-');
  const remote = path.join(base, 'remote.git');
  const repo = path.join(base, 'work');
  fs.mkdirSync(repo);
  sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'main.c'), 'int main(void) { return 0; }\n');
  sh(repo, 'add', 'main.c');
  sh(repo, 'commit', '-q', '-m', 'inicial');
  sh(repo, 'remote', 'add', 'origin', remote);
  return { repo, remote };
}
