/** DDL compatible with seekdb embedded (MySQL-style). TEXT/MEDIUMTEXT cannot have DEFAULT in strict engines. */
export const SQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (
    slug VARCHAR(768) PRIMARY KEY,
    type VARCHAR(128) NOT NULL,
    title VARCHAR(512) NOT NULL,
    compiled_truth MEDIUMTEXT NOT NULL,
    timeline MEDIUMTEXT NOT NULL,
    frontmatter MEDIUMTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS links (
    from_slug VARCHAR(768) NOT NULL,
    to_slug VARCHAR(768) NOT NULL,
    context MEDIUMTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    UNIQUE(from_slug, to_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS timeline_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    page_slug VARCHAR(768) NOT NULL,
    date VARCHAR(32) NOT NULL,
    source VARCHAR(128) NOT NULL,
    summary VARCHAR(1024) NOT NULL,
    detail MEDIUMTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS raw_data (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    page_slug VARCHAR(768) NOT NULL,
    source VARCHAR(256) NOT NULL,
    data MEDIUMTEXT NOT NULL,
    fetched_at VARCHAR(64) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS page_tags (
    page_slug VARCHAR(768) NOT NULL,
    tag VARCHAR(256) NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    UNIQUE(page_slug, tag)
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_ref VARCHAR(1024) NOT NULL,
    source_type VARCHAR(128) NOT NULL,
    detail MEDIUMTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL
  )`,
];
