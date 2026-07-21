'use strict';

const fs = require('fs');

const GIB = 1024 * 1024 * 1024;
const MIN_SYSTEM_RESERVE_BYTES = 5 * GIB;
const MAX_SYSTEM_RESERVE_BYTES = 20 * GIB;
const SYSTEM_RESERVE_PERCENT = 10n;

function asBigInt(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${label} is invalid`);
}

function diskStats(target, statfs) {
  const read = statfs || ((value) => fs.statfsSync(value, { bigint: true }));
  const stats = read(target);
  const blockSize = asBigInt(stats.bsize, 'disk block size');
  const availableBlocks = asBigInt(stats.bavail, 'available disk blocks');
  const totalBlocks = asBigInt(stats.blocks, 'total disk blocks');
  if (blockSize < 1n || totalBlocks < 1n) throw new Error('disk capacity information is unavailable');
  return {
    freeBytes: availableBlocks * blockSize,
    totalBytes: totalBlocks * blockSize,
  };
}

function safetyReserveBytes(totalBytes) {
  const total = asBigInt(totalBytes, 'total disk capacity');
  const proportional = total * SYSTEM_RESERVE_PERCENT / 100n;
  return proportional < BigInt(MIN_SYSTEM_RESERVE_BYTES)
    ? BigInt(MIN_SYSTEM_RESERVE_BYTES)
    : proportional > BigInt(MAX_SYSTEM_RESERVE_BYTES)
      ? BigInt(MAX_SYSTEM_RESERVE_BYTES)
      : proportional;
}

function formatBytes(value) {
  const bytes = asBigInt(value, 'byte count');
  const mib = 1024n * 1024n;
  const gib = 1024n * mib;
  if (bytes >= gib) return `${(Number(bytes * 10n / gib) / 10).toFixed(1)} GiB`;
  if (bytes < 1n) return '0 B';
  if (bytes < mib) return `${Math.ceil(Number(bytes) / 1024)} KiB`;
  return `${Math.ceil(Number(bytes) / Number(mib))} MiB`;
}

function requireHealthyFreeSpace(target, upcomingBytes, operation, options) {
  options = options || {};
  const needed = asBigInt(upcomingBytes, 'required temporary storage');
  const stats = diskStats(target, options.statfs);
  const reserve = options.reserveBytes === undefined
    ? safetyReserveBytes(stats.totalBytes)
    : asBigInt(options.reserveBytes, 'disk safety reserve');
  const required = needed + reserve;
  if (stats.freeBytes < required) {
    const shortBy = required - stats.freeBytes;
    throw new Error(
      `${operation || 'Carry'} needs ${formatBytes(needed)} of temporary space while keeping ` +
      `${formatBytes(reserve)} free for SSD and system health. Free another ${formatBytes(shortBy)} and try again`,
    );
  }
  return { ...stats, reserveBytes: reserve, requiredBytes: required };
}

module.exports = {
  GIB,
  MIN_SYSTEM_RESERVE_BYTES,
  MAX_SYSTEM_RESERVE_BYTES,
  SYSTEM_RESERVE_PERCENT,
  diskStats,
  safetyReserveBytes,
  formatBytes,
  requireHealthyFreeSpace,
};
