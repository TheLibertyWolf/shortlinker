process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://shortlinker:test-password@127.0.0.1:5432/shortlinker";
process.env.REDIS_URL = "redis://127.0.0.1:6379/15";
process.env.APP_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.IP_HASH_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
process.env.ADMIN_ALLOWED_CIDRS = "127.0.0.1/32,82.125.126.40/32";
