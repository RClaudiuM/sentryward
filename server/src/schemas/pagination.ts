import { z } from "zod";

// Lists are paged with skip = (page - 1) * limit. Without a ceiling a huge page
// overflows what Prisma and Postgres accept for OFFSET and the request ends as
// a 500; a million pages is far beyond any real list, so nothing is cut off.
export const MAX_PAGE = 1_000_000;

export const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE).default(1);
