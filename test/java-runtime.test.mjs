import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJavaRuntime, parseJavaRuntimeDetails } from "../src/lib/java-runtime.mjs";

test("Java runtime detection accepts 64-bit runtimes", () => {
  const details = parseJavaRuntimeDetails(`
    java.version = 21.0.5
    os.arch = amd64
    sun.arch.data.model = 64
  `);
  assert.equal(details.is64Bit, true);
  assert.equal(details.version, "21.0.5");
  assert.doesNotThrow(() => assertSupportedJavaRuntime(details));
});

test("Java runtime detection rejects the 32-bit JVM that cannot allocate 4 GB", () => {
  const details = parseJavaRuntimeDetails(`
    java.version = 21.0.5
    os.arch = x86
    sun.arch.data.model = 32
  `);
  assert.equal(details.is64Bit, false);
  assert.throws(() => assertSupportedJavaRuntime(details), /64-bit Java is required/);
});

test("Java runtime detection falls back to architecture when the data model is absent", () => {
  assert.equal(parseJavaRuntimeDetails("os.arch = aarch64").is64Bit, true);
  assert.equal(parseJavaRuntimeDetails("os.arch = i386").is64Bit, false);
});
