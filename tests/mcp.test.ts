import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpBilibili, coverUrl, loginAccount, postReceipt } from '../server/bilibili.js';
import { toolNames } from '../server/model.js';
test('send receipts keep only valid display fields and Bilibili image covers over HTTPS', () => {
  assert.deepEqual(postReceipt({ success:true,message:'评论发送成功',rpid:290501715345,cover:'//i0.hdslb.com/bfs/archive/a.jpg',stat:{ view:1,like:2,reply:3,favorite:4 } }),{ rpid:290501715345,cover:'https://i0.hdslb.com/bfs/archive/a.jpg',stats:{ view:1,like:2,reply:3,favorite:4 } });
  assert.deepEqual(postReceipt({ success:true,rpid:'7',cover:'https://example.invalid/a.jpg',stat:{ view:-1 } }),{});
  assert.deepEqual(postReceipt({ success:true,cover:'http://i2.hdslb.com/bfs/archive/b.png' }),{ cover:'https://i2.hdslb.com/bfs/archive/b.png' });
  assert.deepEqual(postReceipt('not an object'),{});
  for (const unsafe of ['javascript:alert(1)','https://hdslb.com.example.invalid/a.jpg','ftp://i0.hdslb.com/a.jpg','not a url']) assert.equal(coverUrl(unsafe),undefined);
});
test('login checks carry the renewal report, and a malformed report never fails the check', () => {
  assert.deepEqual(loginAccount({ logged_in:true,uid:'100',username:'测试',message:'已登录',renewal:{ status:'renewed',at:1 } }),{ loggedIn:true,uid:'100',username:'测试',message:'已登录',renewal:{ status:'renewed',at:1 } });
  // Compare as served over JSON: absent optional fields may exist as undefined keys.
  const served = (data: unknown) => JSON.parse(JSON.stringify(loginAccount(data)));
  assert.deepEqual(served({ logged_in:true,message:'已登录',renewal:{ status:'unknown' } }),{ loggedIn:true,message:'已登录' });
  assert.deepEqual(served({ logged_in:false,message:'未登录' }),{ loggedIn:false,message:'未登录' });
});
test('pinned Python MCP runtime registers the exact 27 approved tools without calling tools', async () => {
  const directory = await mkdtemp(join(tmpdir(),'yui-mcp-'));
  const client = new McpBilibili(process.env.PYTHON ?? '.venv/bin/python',join(directory,'absent-credential.json'));
  try {
    const tools = await client.tools();
    assert.deepEqual(tools.map(tool => tool.name).sort(),[...toolNames].sort());
  } finally { await client.close(); await rm(directory,{recursive:true}); }
});
