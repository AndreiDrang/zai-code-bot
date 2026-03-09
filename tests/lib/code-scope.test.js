import { test, describe, expect } from 'vitest';
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
    
    expect(Array.isArray(result.target)).toBeTruthy();
    expect(Array.isArray(result.surrounding)).toBeTruthy();
    expect(result.fallback).toBe(false);
    expect(result.bounds.start <= 5).toBeTruthy();
    expect(result.bounds.end >= 6).toBeTruthy();
  });

  test('clamps window to file bounds', () => {
    const content = 'line1\nline2\nline3';
    const result = extractWindow(content, 1, 2, 10);
    
    expect(result.bounds.start).toBe(1);
    expect(result.bounds.maxLines).toBe(3);
  });

  test('handles invalid content gracefully', () => {
    const result = extractWindow(null, 1, 5);
    
    expect(result.fallback).toBe(true);
    expect(result.target).toEqual([]);
    expect(result.note.includes('Invalid content')).toBe(true);
  });

  test('handles empty string content', () => {
    const result = extractWindow('', 1, 5);
    
    expect(result.fallback).toBe(true);
  });

  test('handles invalid start line', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractWindow(content, 10, 15);
    
    expect(result.fallback).toBe(true);
    expect(result.note.includes('Invalid target range')).toBe(true);
  });

  test('handles start > end', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractWindow(content, 5, 1);
    
    expect(result.fallback).toBe(true);
  });

  test('uses default window size when not specified', () => {
    const content = Array(50).fill('line').join('\n');
    const result = extractWindow(content, 25, 25);
    
    expect(result.fallback).toBe(false);
    expect(result.bounds.start <= 25 - DEFAULT_WINDOW_SIZE).toBeTruthy();
    expect(result.bounds.end >= 25 + DEFAULT_WINDOW_SIZE).toBeTruthy();
  });

  test('extracts correct target lines', () => {
    const content = 'a\nb\nc\nd\ne';
    const result = extractWindow(content, 2, 3, 1);
    
    expect(result.target).toEqual(['b', 'c']);
  });
});

describe('code-scope.js - extractTargetBlock', () => {
  test('extracts exact line range', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractTargetBlock(content, 2, 4);
    
    expect(result.fallback).toBe(false);
    expect(result.target).toEqual(['line2', 'line3', 'line4']);
    expect(result.bounds.start).toBe(2);
    expect(result.bounds.end).toBe(4);
  });

  test('handles single line extraction', () => {
    const content = 'line1\nline2\nline3';
    const result = extractTargetBlock(content, 2, 2);
    
    expect(result.fallback).toBe(false);
    expect(result.target).toEqual(['line2']);
  });

  test('handles invalid content', () => {
    const result = extractTargetBlock(null, 1, 5);
    
    expect(result.fallback).toBe(true);
    expect(result.target).toEqual([]);
    expect(result.note.includes('Invalid content')).toBe(true);
  });

  test('handles out of bounds range', () => {
    const content = 'line1\nline2\nline3';
    const result = extractTargetBlock(content, 10, 20);
    
    expect(result.fallback).toBe(true);
    expect(result.note.includes('Invalid range')).toBe(true);
  });

  test('handles invalid line order', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractTargetBlock(content, 5, 1);
    
    expect(result.fallback).toBe(true);
  });

  test('includes bounds metadata', () => {
    const content = 'a\nb\nc';
    const result = extractTargetBlock(content, 1, 2);
    
    expect(result.bounds.start).toBe(1);
    expect(result.bounds.end).toBe(2);
    expect(result.bounds.maxLines).toBe(3);
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
    
    expect(result.target.length > 0).toBeTruthy();
    expect(result.bounds.start <= 3).toBeTruthy();
    expect(result.bounds.end >= 3).toBeTruthy();
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
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('extracts async function block', () => {
    const content = `
async function fetchData() {
  const response = await fetch(url);
  return response.json();
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('extracts exported function block', () => {
    const content = `
export function helper() {
  return 42;
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('extracts default exported function', () => {
    const content = `
export default function main() {
  console.log('main');
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('handles arrow function', () => {
    const content = `
const add = (a, b) => {
  return a + b;
};
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('handles invalid content', () => {
    const result = extractEnclosingBlock(null, 1);
    
    expect(result.fallback).toBe(true);
    expect(result.target).toEqual([]);
    expect(result.note.includes('Invalid content')).toBe(true);
  });

  test('handles anchor line out of bounds', () => {
    const content = 'line1\nline2\nline3';
    const result = extractEnclosingBlock(content, 100);
    
    expect(result.fallback === true || result.target.length > 0).toBeTruthy();
  });

  test('handles anchor line less than 1', () => {
    const content = 'line1\nline2\nline3';
    const result = extractEnclosingBlock(content, 0);
    
    expect(result.fallback === true || result.target.length > 0).toBeTruthy();
  });

  test('uses custom options', () => {
    const content = Array(50).fill('line').join('\n');
    const result = extractEnclosingBlock(content, 25, { 
      maxSearchLines: 5, 
      windowSize: 5 
    });
    
    expect(result.target.length > 0).toBeTruthy();
  });

  test('falls back to window when no block found', () => {
    const content = 'x = 1\ny = 2\nz = 3';
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
    expect(result.fallback === true || result.target.length > 0).toBeTruthy();
  });

  test('handles brace matching', () => {
    const content = `
if (condition) {
  doSomething();
}
    `.trim();
    const result = extractEnclosingBlock(content, 2);
    
    expect(result.target.length > 0).toBeTruthy();
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
    
    expect(result.target.length > 0).toBeTruthy();
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
    
    expect(result.target.length > 0).toBeTruthy();
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
    
    expect(result.target.length > 0).toBeTruthy();
  });
});

describe('code-scope.js - DEFAULT_WINDOW_SIZE', () => {
  test('is defined with expected value', () => {
    expect(DEFAULT_WINDOW_SIZE).toBe(15);
  });
});
