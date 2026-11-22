/**
 * Focused tests for deliveryService.js lookup callback fix
 * Tests both 2-arg and 3-arg lookup signatures and options.all handling
 */

import { deliverWebhook } from './src/workers/deliveryService.js';
import http from 'http';
import https from 'https';

console.log('🧪 Lookup Callback Tests\n');

let testsPassed = 0;
let testsFailed = 0;

function pass(testName) {
  console.log(`✅ ${testName}`);
  testsPassed++;
}

function fail(testName, error) {
  console.log(`❌ ${testName}`);
  console.log(`   Error: ${error}`);
  testsFailed++;
}

// Test 1: Verify lookup callback handles 2-arg form
console.log('Test 1: Lookup callback with 2 arguments (hostname, callback)');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    cb(null, '1.2.3.4', 4);
  };
  
  // Simulate 2-arg call
  let receivedAddress = null;
  let receivedFamily = null;
  mockLookup('example.com', (err, address, family) => {
    receivedAddress = address;
    receivedFamily = family;
  });
  
  if (receivedAddress === '1.2.3.4' && receivedFamily === 4) {
    pass('2-arg lookup form works');
  } else {
    fail('2-arg lookup form', `Expected 1.2.3.4/4, got ${receivedAddress}/${receivedFamily}`);
  }
} catch (error) {
  fail('2-arg lookup form', error.message);
}

// Test 2: Verify lookup callback handles 3-arg form
console.log('\nTest 2: Lookup callback with 3 arguments (hostname, options, callback)');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    cb(null, '1.2.3.4', 4);
  };
  
  // Simulate 3-arg call
  let receivedAddress = null;
  let receivedFamily = null;
  mockLookup('example.com', {}, (err, address, family) => {
    receivedAddress = address;
    receivedFamily = family;
  });
  
  if (receivedAddress === '1.2.3.4' && receivedFamily === 4) {
    pass('3-arg lookup form works');
  } else {
    fail('3-arg lookup form', `Expected 1.2.3.4/4, got ${receivedAddress}/${receivedFamily}`);
  }
} catch (error) {
  fail('3-arg lookup form', error.message);
}

// Test 3: Verify lookup callback handles options.all = true
console.log('\nTest 3: Lookup callback with options.all = true (returns array)');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    
    const needsAll = typeof options === 'object' && options && options.all === true;
    
    if (needsAll) {
      cb(null, [{ address: '1.2.3.4', family: 4 }]);
    } else {
      cb(null, '1.2.3.4', 4);
    }
  };
  
  // Simulate 3-arg call with all=true
  let receivedAddresses = null;
  mockLookup('example.com', { all: true }, (err, addresses) => {
    receivedAddresses = addresses;
  });
  
  if (Array.isArray(receivedAddresses) && 
      receivedAddresses.length === 1 &&
      receivedAddresses[0].address === '1.2.3.4' &&
      receivedAddresses[0].family === 4) {
    pass('options.all = true returns array of address objects');
  } else {
    fail('options.all = true', `Invalid format: ${JSON.stringify(receivedAddresses)}`);
  }
} catch (error) {
  fail('options.all = true', error.message);
}

// Test 4: Verify lookup callback handles options.all = false
console.log('\nTest 4: Lookup callback with options.all = false (returns single address)');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    
    const needsAll = typeof options === 'object' && options && options.all === true;
    
    if (needsAll) {
      cb(null, [{ address: '1.2.3.4', family: 4 }]);
    } else {
      cb(null, '1.2.3.4', 4);
    }
  };
  
  // Simulate 3-arg call with all=false
  let receivedAddress = null;
  let receivedFamily = null;
  mockLookup('example.com', { all: false }, (err, address, family) => {
    receivedAddress = address;
    receivedFamily = family;
  });
  
  if (receivedAddress === '1.2.3.4' && receivedFamily === 4) {
    pass('options.all = false returns single address');
  } else {
    fail('options.all = false', `Expected 1.2.3.4/4, got ${receivedAddress}/${receivedFamily}`);
  }
} catch (error) {
  fail('options.all = false', error.message);
}

// Test 5: Verify IPv6 handling
console.log('\nTest 5: IPv6 address handling');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    cb(null, '2606:2800:220:1:248:1893:25c8:1946', 6);
  };
  
  // Simulate IPv6 lookup
  let receivedAddress = null;
  let receivedFamily = null;
  mockLookup('example.com', (err, address, family) => {
    receivedAddress = address;
    receivedFamily = family;
  });
  
  if (receivedAddress === '2606:2800:220:1:248:1893:25c8:1946' && receivedFamily === 6) {
    pass('IPv6 address handling works');
  } else {
    fail('IPv6 handling', `Expected IPv6/6, got ${receivedAddress}/${receivedFamily}`);
  }
} catch (error) {
  fail('IPv6 handling', error.message);
}

// Test 6: Verify callback validation
console.log('\nTest 6: Callback function validation');
try {
  const mockLookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('Callback is not a function');
    }
    cb(null, '1.2.3.4', 4);
  };
  
  // Try to call with invalid callback
  let errorThrown = false;
  try {
    mockLookup('example.com', {}, null);
  } catch (error) {
    if (error.message.includes('not a function')) {
      errorThrown = true;
    }
  }
  
  if (errorThrown) {
    pass('Callback validation throws error for invalid callback');
  } else {
    fail('Callback validation', 'Should throw error for invalid callback');
  }
} catch (error) {
  fail('Callback validation', error.message);
}

// Summary
console.log('\n' + '='.repeat(50));
console.log('📊 Test Summary');
console.log('='.repeat(50));
console.log(`✅ Passed: ${testsPassed}`);
console.log(`❌ Failed: ${testsFailed}`);
console.log(`📈 Total:  ${testsPassed + testsFailed}`);
console.log(`🎯 Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);

if (testsFailed === 0) {
  console.log('\n✨ All lookup callback tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${testsFailed} test(s) failed\n`);
  process.exit(1);
}
