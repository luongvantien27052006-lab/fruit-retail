import type { Client } from 'pg';

/** Role ứng dụng (ADR-011). */
export const APP_ROLES = ['app_rw', 'projector_rw', 'viewer_ro', 'viewer_act', 'audit_writer'] as const;

export interface PrivilegeViolation {
  table: string;
  role: string;
  privilege: 'UPDATE' | 'DELETE' | 'TRUNCATE';
}

/**
 * Mọi bảng có trigger gọi core.raise_immutable() là bảng chỉ-thêm (FR-INV-05/12): không role ứng dụng nào được
 * UPDATE/DELETE/TRUNCATE. Chạy trong test DB/CI sau mỗi migration — chặn trường hợp migration quên REVOKE.
 */
export async function checkAppendOnlyPrivileges(client: Client): Promise<PrivilegeViolation[]> {
  const { rows } = await client.query<{ table: string; role: string; privilege: PrivilegeViolation['privilege'] }>(
    `WITH t AS (
       SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS tbl
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = tg.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
       WHERE NOT tg.tgisinternal AND pn.nspname = 'core' AND p.proname = 'raise_immutable'
     )
     SELECT t.tbl AS "table", r.role, pr.privilege
     FROM t
     CROSS JOIN unnest($1::text[]) AS r(role)
     CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS pr(privilege)
     WHERE has_table_privilege(r.role, t.tbl, pr.privilege)
     ORDER BY 1, 2, 3`,
    [APP_ROLES],
  );
  return rows;
}
