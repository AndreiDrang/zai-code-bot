const { describe, test } = require('node:test');
const assert = require('node:assert');
const { 
  extractWindow, 
  extractTargetBlock, 
  extractEnclosingBlock,
  DEFAULT_WINDOW_SIZE 
} = require('../../src/lib/code-scope');

describe('code-scope.js - extractWindow', () => {
  test('extracts target lines with surrounding context', () => {
    const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    const result = extractWindow(content, 5, 6, 2);
    
    assert.ok(Array.isArray(result.target));
    assert.ok(Array.isArray(result.surrounding));
    assert.strictEqual(result.fallback, false);
    assert.ok(result.bounds.start <= 5);
    assert.ok(result.bounds.end >= 6);
  });

  test('clamps window to file bounds', () => {
    const content = 'line1\nline2\nline3';
    const result = extractWindow(content, 1, 2, 10);
    
    assert.strictEqual(result.bounds.start, 1);
    assert.strictEqual(result.bounds.maxLines, 3);
  });

  test('handles invalid content gracefully', () => {
    const result = extractWindow(null, 1, 5);
    
    assert.strictEqual(result.fallback, true);
    assert.deepStrictEqual(result.target, []);
    assert.ok(result.note.includes('Invalid content'));
  });

  test('handles empty string content', () => {
    const result = extractWindow('', 1, 5);
    
    assert.strictEqual(result.fallback, true);
  });

  test('handles invalid start line', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractWindow(content, 10, 15);
    
    assert.strictEqual(result.fallback, true);
    assert.ok(result.note.includes('Invalid target range'));
  });

  test('handles start > end', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractWindow(content, 5, 1);
    
    assert.strictEqual(result.fallback, true);
  });

  test('uses default window size when not specified', () => {
    const content = Array(50).fill('line').join('\n');
    const result = extractWindow(content, 25, 25);
    
    assert.strictEqual(result.fallback, false);
    assert.ok(result.bounds.start <= 25 - DEFAULT_WINDOW_SIZE);
    assert.ok(result.bounds.end >= 25 + DEFAULT_WINDOW_SIZE);
  });

  test('extracts correct target lines', () => {
    const content = 'a\nb\nc\nd\ne';
    const result = extractWindow(content, 2, 3, 1);
    
    assert.deepStrictEqual(result.target, ['b', 'c']);
  });
});

describe('code-scope.js - extractTargetBlock', () => {
  test('extracts exact line range', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractTargetBlock(content, 2, 4);
    
    assert.strictEqual(result.fallback, false);
    assert.deepStrictEqual(result.target, ['line2', 'line3', 'line4']);
    assert.strictEqual(result.bounds.start, 2);
    assert.strictEqual(result.bounds.end, 4);
  });

  test('handles single line extraction', () => {
    const content = 'line1\nline2\nline3';
    const result = extractTargetBlock(content, 2, 2);
    
    assert.strictEqual(result.fallback, false);
    assert.deepStrictEqual(result.target, ['line2']);
  });

  test('handles invalid content', () => {
    const result = extractTargetBlock(null, 1, 5);
    
    assert.strictEqual(result.fallback, true);
    assert.deepStrictEqual(result.target, []);
    assert.ok(result.note.includes('Invalid content'));
  });

  test('handles out of bounds range', () => {
    const content = 'line1\nline2\nline3';
    const result = extractTargetBlock(content, 10, 20);
    
    assert.strictEqual(result.fallback, true);
    assert.ok(result.note.includes('Invalid range'));
  });

  test('handles invalid line order', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractTargetBlock(content, 5, 1);
    
    assert.strictEqual(result.fallback, true);
  });

  test('includes bounds metadata', () => {
    const content = 'a\nb\nc';
    const result = extractTargetBlock(content, 1, 2);
    
    assert.strictEqual(result.bounds.start, 1);
    assert.strictEqual(result.bounds.end, 2);
    assert.strictEqual(result.bounds.maxLines, 3);
  });
});

describe('code-scope.js - extractEnclosingBlock', () => {
  test('extracts function block', () => {
    const content = `
function myFunction() {
  const x = 1;
  return x + 2;
}
    `.trim();
    const result = extractEnclosingBlock(content, 3);
    
    assert.ok(result.target.length > 0);
    assert.ok(result.bounds.start <= 3);
    assert.ok(result.bounds.end >= 3);
  });

  test('extracts class block', () => {
    const content = `
class MyClass {
  constructor() {
    this.value = 1;
  }
  
  method() {
    return this.value;
  }
}
    `.trim();
    const result = extractEnclosingBlock(content, 4);
    
    assert.ok(result.target.length > 0);
  });

  test('extracts async function block', () => {
    const content = `
async function fetchData() {
  const response = await fetch(url);
  return response.json();
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
  });

  test('extracts exported function block', () => {
    const content = `
export function helper() {
  return 42;
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
  });

  test('extracts default exported function', () => {
    const content = `
export default function main() {
  console.log('main');
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
  });

  test('handles arrow function', () => {
    const content = `
const add = (a, b) => {
  return a + b;
};
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
  });

  test('handles invalid content', () => {
    const result = extractEnclosingBlock(null, 1);
    
    assert.strictEqual(result.fallback, true);
    assert.deepStrictEqual(result.target, []);
    assert.ok(result.note.includes('Invalid content'));
  });

  test('handles anchor line out of bounds', () => {
    const content = 'line1\nline2\nline3';
    const result = extractEnclosingBlock(content, 100);
    
    assert.ok(result.fallback === true || result.target.length > 0);
  });

  test('handles anchor line less than 1', () => {
    const content = 'line1\nline2\nline3';
    const result = extractEnclosingBlock(content, 0);
    
    assert.ok(result.fallback === true || result.target.length > 0);
  });

  test('uses custom options', () => {
    const content = Array(50).fill('line').join('\n');
    const result = extractEnclosingBlock(content, 25, { 
      maxSearchLines: 5, 
      windowSize: 5 
    });
    
    assert.ok(result.target.length > 0);
  });

  test('falls back to window when no block found', () => {
    const content = 'x = 1\ny = 2\nz = 3';
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
    assert.ok(result.fallback === true || result.target.length > 0);
  });

  test('handles brace matching', () => {
    const content = `
if (condition) {
  doSomething();
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    assert.ok(result.target.length > 0);
  });

  test('handles nested braces', () => {
    const content = `
function outer() {
  function inner() {
    return 1;
  }
  return inner();
}
    `.trim();
    const result = extractEnclosingBlock(content, 3);
    
    assert.ok(result.target.length > 0);
  });

  test('handles object method arrow function', () => {
    const content = `
const obj = {
  method: () => {
    return 42;
  }
};
    `.trim();
    const result = extractEnclosingBlock(content, 3);
    
    assert.ok(result.target.length > 0);
  });

  test('handles multiline arrow function', () => {
    const content = `
const fn = (a,
  b,
  c) => {
  return a + b + c;
};
    `.trim();
    const result = extractEnclosingBlock(content, 4);
    
    assert.ok(result.target.length > 0);
  });
});

describe('code-scope.js - DEFAULT_WINDOW_SIZE', () => {
  test('is defined with expected value', () => {
    assert.strictEqual(DEFAULT_WINDOW_SIZE, 15);
  });
});
