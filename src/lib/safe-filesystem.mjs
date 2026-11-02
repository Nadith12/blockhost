import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function isPathInside(parent, child, { allowRoot = false } = {}) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (!relative) return allowRoot;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertPathInside(parent, child, options = {}) {
  if (!isPathInside(parent, child, options)) {
    throw new Error("Refusing to access a path outside the expected server folder");
  }
  return path.resolve(child);
}

function temporarySibling(filePath, label) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${label}-${process.pid}-${crypto.randomUUID()}`
  );
}

export function atomicWriteFile(filePath, contents, encoding = "utf8") {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });

  const temporary = temporarySibling(target, "tmp");
  const displaced = temporarySibling(target, "previous");
  const existed = fs.existsSync(target);
  let handle;

  try {
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, contents, { encoding });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;

    if (existed) {
      const mode = fs.statSync(target).mode;
      fs.chmodSync(temporary, mode);
      fs.renameSync(target, displaced);
    }

    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (existed && fs.existsSync(displaced) && !fs.existsSync(target)) {
        fs.renameSync(displaced, target);
      }
      throw error;
    }

    if (fs.existsSync(displaced)) fs.rmSync(displaced, { force: true });
  } finally {
    if (handle !== null && handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (fs.existsSync(displaced) && !fs.existsSync(target)) {
      fs.renameSync(displaced, target);
    } else if (fs.existsSync(displaced)) {
      fs.rmSync(displaced, { force: true });
    }
  }

  return target;
}

export function writeFileWithBackup(filePath, contents, options = {}) {
  const target = path.resolve(filePath);
  const backupPath = path.resolve(options.backupPath || `${target}.blockhost-backup`);
  const hadOriginal = fs.existsSync(target);

  if (hadOriginal) {
    atomicWriteFile(backupPath, fs.readFileSync(target));
  } else if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }

  atomicWriteFile(target, contents, options.encoding || "utf8");
  return { target, backupPath, hadOriginal };
}

export function restoreFileBackup(transaction) {
  if (!transaction?.target) throw new Error("Invalid file transaction");
  if (transaction.hadOriginal) {
    if (!fs.existsSync(transaction.backupPath)) {
      throw new Error("The previous file backup is missing");
    }
    atomicWriteFile(transaction.target, fs.readFileSync(transaction.backupPath));
  } else if (fs.existsSync(transaction.target)) {
    fs.rmSync(transaction.target, { force: true });
  }
}

export function commitFileBackup(transaction) {
  if (!transaction?.backupPath) return;
  if (fs.existsSync(transaction.backupPath)) fs.rmSync(transaction.backupPath, { force: true });
}
