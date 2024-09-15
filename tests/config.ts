import 'dotenv/config';

const dbUrlsString = process.env.DATABASE_URLS;
if (!dbUrlsString) throw new Error(`Missing DATABASE_URLS env var`);

export const dbUrls = dbUrlsString.split(',');
