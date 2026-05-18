-- 管理画面（admin.html）で全員分の lecture_views を SELECT できるようにする。
-- lecture_views テーブルが存在する場合のみ実行されます。
--
-- Supabase → SQL Editor で実行してください。
-- 管理者メールは admin.html の ADMIN_EMAIL と同じにしてください。

DO $$
BEGIN
  IF to_regclass('public.lecture_views') IS NOT NULL THEN
    DROP POLICY IF EXISTS "admin read lecture_views" ON public.lecture_views;
    CREATE POLICY "admin read lecture_views" ON public.lecture_views
      FOR SELECT
      USING (
        (SELECT email FROM auth.users WHERE id = auth.uid()) = 'shoyaaaaaa1127@gmail.com'
      );
  END IF;
END $$;
