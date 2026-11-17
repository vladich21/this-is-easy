#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');

const REQUEST_COUNT = 10;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;

const BYTES_PER_MEGABYTE = 1_000_000;
const BITS_PER_MEGABIT = 1_000_000;

const REQUEST_HEADERS = {
  'User-Agent': 'internet-speed-test/1.0',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
};

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function describeError(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `превышено время ожидания (${REQUEST_TIMEOUT_MS / 1000} с)`;
  }

  return error.message;
}

function formatMegabytes(bytes) {
  return `${(bytes / BYTES_PER_MEGABYTE).toFixed(2)} МБ`;
}

function formatSpeed(bytes, durationMs) {
  const seconds = durationMs / 1000;
  if (seconds <= 0) {
    return '0.00 Мбит/с';
  }

  const megabitsPerSecond = (bytes * 8) / seconds / BITS_PER_MEGABIT;
  return `${megabitsPerSecond.toFixed(2)} Мбит/с`;
}

function sendGet(url, signal) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error('поддерживаются только адреса http:// и https://'));
  }

  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      parsed,
      {
        method: 'GET',
        headers: REQUEST_HEADERS,
        signal,
      },
      (response) => {
        resolve(response);
      }
    );

    request.on('error', reject);
    request.end();
  });
}

function readBody(response) {
  return new Promise((resolve, reject) => {
    let bytes = 0;

    response.on('data', (chunk) => {
      bytes += chunk.length;
    });
    response.on('end', () => {
      resolve(bytes);
    });
    response.on('error', reject);
  });
}

async function readResource(url, redirectsLeft, signal) {
  const response = await sendGet(url, signal);
  const status = response.statusCode ?? 0;
  const bytes = await readBody(response);
  const location = response.headers.location;

  if (isRedirect(status) && location) {
    if (redirectsLeft <= 0) {
      throw new Error('слишком много перенаправлений');
    }

    const nextUrl = new URL(location, url).toString();
    const next = await readResource(nextUrl, redirectsLeft - 1, signal);

    return {
      status: next.status,
      bytes: bytes + next.bytes,
    };
  }

  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }

  return {
    status,
    bytes,
  };
}

async function measureOnce(url) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const startedAt = process.hrtime.bigint();
  const result = await readResource(url, MAX_REDIRECTS, signal);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    status: result.status,
    bytes: result.bytes,
    durationMs,
  };
}

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error('Использование: node index.js <url>');
    console.error('Пример: node index.js "https://speed.cloudflare.com/__down?bytes=5000000"');
    process.exit(1);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('нужен протокол http:// или https://');
    }
  } catch (error) {
    const message = error.message === 'Invalid URL' ? 'не удалось разобрать адрес' : error.message;
    console.error(`Некорректный адрес: ${message}`);
    process.exit(1);
  }

  console.log(`Адрес: ${url}`);
  console.log(`Запросов: ${REQUEST_COUNT}, строго по очереди`);
  console.log('');

  const samples = [];

  for (let attempt = 1; attempt <= REQUEST_COUNT; attempt += 1) {
    let sample;

    try {
      sample = await measureOnce(url);
    } catch (error) {
      console.error(`Ошибка на запросе ${attempt} из ${REQUEST_COUNT}: ${describeError(error)}`);
      process.exit(1);
    }

    samples.push(sample);

    const number = String(attempt).padStart(2, ' ');
    const duration = `${sample.durationMs.toFixed(0)} мс`;
    console.log(`#${number}  HTTP ${sample.status}  ${formatMegabytes(sample.bytes)}  ${duration}`);
  }

  const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const totalMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
  const averageMs = totalMs / samples.length;

  console.log('');
  console.log(`Среднее время запроса: ${averageMs.toFixed(0)} мс`);
  console.log(`Общий объём: ${formatMegabytes(totalBytes)}`);
  console.log(`Общее время: ${(totalMs / 1000).toFixed(2)} с`);
  console.log(`Скорость скачивания: ${formatSpeed(totalBytes, totalMs)}`);
}

main().catch((error) => {
  console.error(`Ошибка: ${describeError(error)}`);
  process.exit(1);
});
