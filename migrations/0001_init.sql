-- 空库即可启动：没有卡片，只有默认每日目标。不要写入虚构课文。

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  generation INTEGER NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (generation, id)
);

CREATE INDEX IF NOT EXISTS idx_cards_generation ON cards (generation, position);

CREATE TABLE IF NOT EXISTS logs (
  generation INTEGER NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (generation, id)
);

CREATE INDEX IF NOT EXISTS idx_logs_generation ON logs (generation, position);

CREATE TABLE IF NOT EXISTS chat_messages (
  position INTEGER PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  week TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ocr_tasks (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);

INSERT INTO meta (key, value, updated)
SELECT 'settings', '{"dailyGoal":10,"typeGoals":{"单词":4,"语法":3,"例句":3,"其他":0}}', '1970-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'settings');

INSERT INTO meta (key, value, updated)
SELECT 'profile', '{"summary":"","updated":""}', '1970-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'profile');

INSERT INTO meta (key, value, updated)
SELECT 'reset', '{"at":""}', '1970-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'reset');

INSERT INTO meta (key, value, updated)
SELECT 'cards_generation', '0', '1970-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'cards_generation');

INSERT INTO meta (key, value, updated)
SELECT 'logs_generation', '0', '1970-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'logs_generation');
