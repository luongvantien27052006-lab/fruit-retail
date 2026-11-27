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
     -- UPDATE: cả quyền theo cột (has_table_privilege không thấy GRANT UPDATE (cột) — review CP04 lát 1)
     WHERE CASE WHEN pr.privilege = 'UPDATE' THEN has_any_column_privilege(r.role, t.tbl, 'UPDATE')
                ELSE has_table_privilege(r.role, t.tbl, pr.privilege) END
     ORDER BY 1, 2, 3`,
    [APP_ROLES],
  );
  return rows;
}

export interface ViewerRlsViolation {
  table: string;
  problem: 'RLS_DISABLED' | 'RLS_NOT_FORCED' | 'NO_VIEWER_POLICY' | 'OUTSIDE_REPORTING';
}

/**
 * ADR-011 "Kiểm tra bắt buộc": mọi bảng viewer_ro SELECT được phải nằm trong `reporting`, bật + FORCE RLS và có policy
 * áp cho viewer_ro. Thêm bảng reporting mới mà quên RLS/policy → CI đỏ (§2.5 lớp 3–4).
 */
export async function checkViewerRls(client: Client): Promise<ViewerRlsViolation[]> {
  const { rows } = await client.query<{
    table: string;
    nsp: string;
    rls: boolean;
    forced: boolean;
    has_policy: boolean;
  }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table", n.nspname AS nsp,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid
                      AND (p.polroles = '{0}'::oid[] OR 'viewer_ro'::regrole = ANY (p.polroles))) AS has_policy
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND has_table_privilege('viewer_ro', c.oid, 'SELECT')
     ORDER BY 1`,
  );
  const out: ViewerRlsViolation[] = [];
  for (const r of rows) {
    if (r.nsp !== 'reporting') out.push({ table: r.table, problem: 'OUTSIDE_REPORTING' });
    if (!r.rls) out.push({ table: r.table, problem: 'RLS_DISABLED' });
    else if (!r.forced) out.push({ table: r.table, problem: 'RLS_NOT_FORCED' });
    if (!r.has_policy) out.push({ table: r.table, problem: 'NO_VIEWER_POLICY' });
  }
  return out;
}

/**
 * Không role ứng dụng nào được UPDATE cột khóa chính (đổi id → FK ON UPDATE CASCADE kéo theo, phá dấu vết). Default
 * privileges ở core cấp UPDATE cả bảng cho app_rw — migration tạo bảng phải REVOKE UPDATE rồi GRANT theo cột (ADR-020).
 */
export async function checkNoKeyUpdate(client: Client): Promise<{ table: string; column: string; role: string }[]> {
  const { rows } = await client.query<{ table: string; column: string; role: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table", a.attname AS "column", r.role
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
     CROSS JOIN unnest($1::text[]) AS r(role)
     WHERE i.indisprimary
       AND n.nspname IN ('core', 'audit', 'integration', 'reporting', 'reporting_private')
       AND has_column_privilege(r.role, c.oid, a.attnum, 'UPDATE')
     ORDER BY 1, 2, 3`,
    [APP_ROLES],
  );
  return rows;
}
