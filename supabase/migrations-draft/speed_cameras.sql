-- ⚠️ DRAFT — 尚未套用至任何 Supabase 專案（本地或 production）。
-- 本檔案僅為 R7（固定式測速照相導航預警）爬蟲側規格產出物，供後續整合時參考。
-- 若要正式套用，請移出 migrations-draft/ 放進 supabase/migrations/ 並走正常 migration 流程。
--
-- 對應正規化 schema：lib/speed-camera-parser.cjs 輸出的
-- { city, address, road, direction, speed_limit, lat, lng, source, fetched_at }

create table if not exists public.speed_cameras (
  id bigint generated always as identity primary key,
  city text not null,
  address text not null,
  road text,
  direction text,
  speed_limit integer,
  lat double precision,
  lng double precision,
  source text not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 同一來源、同一地址、同一拍攝方向視為同一支測速照相；
  -- direction 用 coalesce 是因為部分縣市（如區間測速）direction 可能為 null。
  constraint speed_cameras_unique_location unique (source, address, direction)
);

comment on table public.speed_cameras is
  '台灣固定式測速照相/科技執法設備地點（正規化後）。來源盤點見 tesla-radar-crawler/docs/speed-camera-sources.md。lat/lng 可能為 null（來源縣市未提供座標，待 geocode 補齊）。';
comment on column public.speed_cameras.source is
  '資料來源代碼，對應 lib/speed-camera-parser.cjs 的 source 欄位（如 taipei, new-taipei, kaohsiung）。';
comment on column public.speed_cameras.speed_limit is
  '速限（km/h）；來源資料若為非數字內容（如高雄「違左」、台北多行字串）則為 null。';

create index if not exists speed_cameras_city_idx on public.speed_cameras (city);
create index if not exists speed_cameras_lat_lng_idx on public.speed_cameras (lat, lng) where lat is not null and lng is not null;
