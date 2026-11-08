const assert = require('assert');
const fs = require('fs');
const readline = require('readline');

// Load compaction implementation from source or function
function runTests(compactOpenCodeContext) {
  console.log('--- RUNNING COMPACTOR UNIT & INTEGRATION TESTS ---');

  // Test 1: Empty or invalid input
  assert.deepStrictEqual(compactOpenCodeContext(null), null);
  assert.deepStrictEqual(compactOpenCodeContext([]), []);
  assert.deepStrictEqual(compactOpenCodeContext(undefined), undefined);
  console.log('✓ Test 1: Empty and invalid inputs handled gracefully');

  // Test 2: Short session (< 12 messages) remains un-truncated
  const shortMessages = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a'.repeat(2000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'b'.repeat(2000) }] },
    { role: 'assistant', content: 'Done!' }
  ];
  // Since length is 5 <= PROTECTED_TAIL (12), tail is preserved intact
  const resShort = compactOpenCodeContext(shortMessages);
  assert.strictEqual(resShort.length, 5);
  assert.strictEqual(resShort[2].content[0].input.path.length, 2000);
  assert.strictEqual(resShort[3].content[0].content.length, 2000);
  console.log('✓ Test 2: Protected tail preserves recent tool inputs and results');

  // Test 3: Deep pruning on older messages (Anthropic, OpenAI, Responses schemas)
  const oldMessages = [
    { role: 'system', content: 'System instruction' },
    { role: 'user', content: 'First task' },
    // Turn 1 (old)
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_old_1', name: 'write', input: { code: 'x'.repeat(1000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_old_1', content: 'y'.repeat(1000) }] },
    // Turn 2 (old OpenAI style)
    { role: 'assistant', tool_calls: [{ id: 'call_old_2', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ cmd: 'z'.repeat(1000) }) } }] },
    { role: 'tool', tool_call_id: 'call_old_2', content: 'output'.repeat(200) },
    // Turn 3 (old Responses style)
    { type: 'function_call', call_id: 'call_old_3', name: 'exec', arguments: 'arg'.repeat(200) },
    { type: 'function_call_output', call_id: 'call_old_3', output: 'res'.repeat(200) }
  ];
  // Add 13 tail messages to push old messages outside PROTECTED_TAIL (12)
  for (let i = 0; i < 13; i++) {
    oldMessages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Tail msg ${i}` });
  }

  const resPruned = compactOpenCodeContext(oldMessages);
  // Check that old tool_use input was truncated
  const oldToolUse = resPruned[2].content[0];
  assert.ok(oldToolUse.input._truncated, 'tool_use input should be marked as truncated');
  assert.ok(oldToolUse.input._truncated.includes('[truncated for OpenCode free budget]'));

  // Check that old tool_result content was truncated
  const oldToolResult = resPruned[3].content[0];
  assert.ok(oldToolResult.content.includes('[truncated for OpenCode free budget]'));
  assert.ok(oldToolResult.content.length < 300);

  // Check old OpenAI tool was truncated
  assert.ok(resPruned[5].content.includes('[truncated for OpenCode free budget]'));

  // Check old Responses style was truncated
  assert.ok(resPruned[6].arguments.includes('[truncated for OpenCode free budget]'));
  assert.ok(resPruned[7].output.includes('[truncated for OpenCode free budget]'));

  console.log('✓ Test 3: Multi-schema deep pruning successfully applied to old messages');

  // Test 4: Pair-Safe Sliding Window (never leave orphaned tool_result)
  const longConversation = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Initial user task' }
  ];
  for (let i = 0; i < 30; i++) {
    const id = `call_${i}`;
    longConversation.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'bash', input: { command: `echo ${i}` } }]
    });
    longConversation.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: `result ${i}` }]
    });
  }
  // Total messages: 2 + 60 = 62 (> 44)
  const resSliding = compactOpenCodeContext(longConversation);
  assert.ok(resSliding.length <= 44, `Window should be <= 44, got ${resSliding.length}`);

  // Verify first message is system, second is initial user
  assert.strictEqual(resSliding[0].role, 'system');
  assert.strictEqual(resSliding[1].role, 'user');
  assert.strictEqual(resSliding[1].content, 'Initial user task');

  // Verify pair integrity: No tool_result exists without a preceding tool_use in the window
  const activeToolUseIds = new Set();
  for (let i = 0; i < resSliding.length; i++) {
    const msg = resSliding[i];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          activeToolUseIds.add(block.id);
        } else if (block.type === 'tool_result') {
          assert.ok(
            activeToolUseIds.has(block.tool_use_id),
            `Found orphaned tool_result for tool_use_id: ${block.tool_use_id} at index ${i}`
          );
        }
      }
    }
  }
  console.log('✓ Test 4: Pair-Safe Sliding Window maintains 100% pair integrity (0 orphaned tool_results)');

  // Test 5: Real-world 6.0 MB Article Session Compaction Test
  const transcriptPath = '/Users/hoangson/.claude/projects/-Users-hoangson-Projects-Article--claude-worktrees-sleepy-keller-e16c74/b2fdb1a4-9146-4f73-b663-12c475c9c662.jsonl';
  if (fs.existsSync(transcriptPath)) {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    const realMessages = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.message && item.message.role) {
          realMessages.push(item.message);
        } else if (item.type === 'user' && item.message) {
          realMessages.push(item.message);
        }
      } catch (e) {}
    }

    console.log(`Loaded ${realMessages.length} real turns from Article session`);
    const compacted = compactOpenCodeContext(realMessages);
    const serialized = JSON.stringify(compacted);
    console.log(`Compacted size: ${serialized.length} characters (Original file: 6.0 MB)`);
    assert.ok(serialized.length <= 35000, `Payload must be <= 35,000 chars, got ${serialized.length}`);

    // Verify pair integrity on real data
    const realToolUseIds = new Set();
    for (const msg of compacted) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use') {
            realToolUseIds.add(block.id);
          } else if (block && block.type === 'tool_result') {
            assert.ok(
              realToolUseIds.has(block.tool_use_id),
              `Orphaned tool_result in real session: ${block.tool_use_id}`
            );
          }
        }
      }
    }
    console.log('✓ Test 5: Real Article 6.0 MB session successfully compressed to < 35,000 chars with 100% pair integrity');
  }

  console.log('\n>>> ALL COMPACTOR TESTS PASSED 100% <<<');
}

if (require.main === module) {
  const code = fs.readFileSync('/Users/hoangson/.local/lib/node_modules/9router/app/.next-cli-build/server/chunks/5330.js', 'utf8');
  const startIdx = code.indexOf('function compactOpenCodeContext(messages) {');
  if (startIdx === -1) throw new Error('compactOpenCodeContext not found in 5330.js');
  const endIdx = code.indexOf('\nclass G extends', startIdx);
  const fnSource = code.slice(startIdx, endIdx);
  const fn = eval(`(${fnSource})`);
  runTests(fn);
}

module.exports = { runTests };
