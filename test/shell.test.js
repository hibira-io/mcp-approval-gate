import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShell, splitShell } from '../src/shell.js';

const cases = [
 ['ls -la', false], ['rm -rf node_modules', false], ['rm -rf src', true], ['rm -fr ./build dist', false], ['rm file.txt', false],
 ['git push', false], ['git push -f origin main', true], ['git push origin +main', true], ['git push --force-with-lease', true], ['git -C repo push --force', true],
 ['git commit -m "rm -rf everything; terraform apply"', false], ['echo "git push --force"', false],
 ['terraform plan', false], ['terraform apply -auto-approve', true], ['cd infra && terraform destroy', true],
 ['bash -c "rm -rf /var/www"', true], ['sudo -u deploy rm -rf /srv/app', true], ['ssh prod "sudo systemctl stop nginx"', true],
 ['npx vercel --prod', true], ['npx vercel', false], ['vercel deploy --prod', true], ['fly deploy', true], ['wrangler deploy', true], ['wrangler dev', false],
 ['npm publish', true], ['npm run deploy:prod', true], ['npm run build', false], ['pnpm deploy', true], ['make deploy', true], ['make test', false],
 ['psql -c "select 1"', false], ['psql "$DATABASE_URL" -c "DELETE FROM users"', true], ['psql $DB <<SQL\nUPDATE t SET a=1;\nSQL', true], ['psql $DB <<SQL\nselect 1;\nSQL', false],
 ['echo "DROP TABLE x" | psql', true], ['psql -f migrate.sql', true], ['mysql -e "show tables"', false], ['sqlite3 app.db "delete from t"', true],
 ['kubectl get pods', false], ['kubectl delete pod x', true], ['helm upgrade app .', true], ['docker push img', true], ['docker build .', false],
 ['aws s3 ls', false], ['aws s3 rm s3://b/k', true], ['aws ec2 describe-instances', false], ['aws ec2 terminate-instances --instance-ids i-1', true],
 ['gh pr view 1', false], ['gh pr merge 1', true], ['prisma migrate dev', false], ['npx prisma migrate deploy', true], ['php artisan migrate --force', true], ['php artisan test', false],
 ['redis-cli FLUSHALL', true], ['redis-cli get k', false], ['find . -name "*.log" -delete', true], ['curl -X DELETE https://api.example.com/x', true], ['curl https://x.com', false],
 ['git reset --hard HEAD~1', true], ['git clean -fdx', true], ['git branch -D feat', true], ['git checkout -- .', true], ['git checkout main', false],
 ['FOO=1 env BAR=2 timeout 10 terraform apply', true], ['echo $(rm -rf ~/x)', true], ['ls | xargs rm -rf', true],
];

test('risky commands ask, everyday commands do not', () => {
  for (const [command, want] of cases) {
    const v = classifyShell(command);
    assert.equal(v.gate, want, `${command}: ${JSON.stringify(v.reasons)}`);
  }
});

test('always and never lists', () => {
  assert.equal(classifyShell('rm -rf node_modules', { always: ['^rm '] }).gate, true);
  assert.equal(classifyShell('terraform apply', { never: ['^terraform apply'] }).gate, false);
  assert.equal(classifyShell('terraform apply', { never: ['^terraform'], always: ['apply'] }).gate, true);
  assert.equal(classifyShell('./scripts/ship.sh', { always: ['ship\\.sh'] }).gate, true);
});

test('looks through wrappers and remote shells', () => {
  const v = classifyShell("ssh deploy@prod 'cd /srv && git reset --hard origin/main'");
  assert.equal(v.gate, true);
  assert.equal(v.reasons[0].remote, true);
  assert.equal(classifyShell('kubectl exec -it pod -- rm -rf /data').gate, true);
  assert.equal(classifyShell('op run -- terraform apply').gate, true);
  assert.equal(classifyShell('uv run alembic upgrade head').gate, true);
});

test('SQL warnings come through', () => {
  const v = classifyShell('psql -c "DELETE FROM orders"');
  assert.equal(v.gate, true);
  assert.ok(v.warnings.some((w) => /WHERE/.test(w)));
});

test('splitShell keeps quotes and heredocs', () => {
  const cmds = splitShell("echo 'a; b' && psql <<'EOF'\nDELETE FROM t;\nEOF\nls");
  assert.deepEqual(cmds.map((c) => c.argv[0]), ['echo', 'psql', 'ls']);
  assert.equal(cmds[0].argv[1], 'a; b');
  assert.equal(cmds[1].heredoc, 'DELETE FROM t;');
});
