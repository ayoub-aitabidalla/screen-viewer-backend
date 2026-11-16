--
-- PostgreSQL database dump
--

\restrict D0rBPGFJ0ho1gk1RX1SIyukccRenUVZw7leSf0tAJvJhHlNhMvLAZ82D8ne0BGo

-- Dumped from database version 16.16
-- Dumped by pg_dump version 16.16

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cameras; Type: TABLE; Schema: public; Owner: screenviewer
--

CREATE TABLE public.cameras (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(32) NOT NULL,
    stream_path character varying(128) NOT NULL,
    go2rtc_name character varying(128) NOT NULL,
    dvr_channel_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    dvr_id uuid NOT NULL
);


ALTER TABLE public.cameras OWNER TO screenviewer;

--
-- Name: dvrs; Type: TABLE; Schema: public; Owner: screenviewer
--

CREATE TABLE public.dvrs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(64) NOT NULL,
    host character varying(128) NOT NULL,
    username character varying(64) NOT NULL,
    password_enc text NOT NULL,
    go2rtc_url character varying(256) NOT NULL,
    onvif_host character varying(128) NOT NULL,
    onvif_port integer DEFAULT 1984 NOT NULL,
    onvif_user character varying(64) DEFAULT 'admin'::character varying NOT NULL,
    onvif_password_enc text NOT NULL,
    mediamtx_rtsp_url character varying(256) NOT NULL,
    mediamtx_api_url character varying(256) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.dvrs OWNER TO screenviewer;

--
-- Name: tenants; Type: TABLE; Schema: public; Owner: screenviewer
--

CREATE TABLE public.tenants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(64) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.tenants OWNER TO screenviewer;

--
-- Name: users; Type: TABLE; Schema: public; Owner: screenviewer
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    username character varying(64) NOT NULL,
    password_hash character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    role character varying(16) DEFAULT 'admin'::character varying NOT NULL,
    tenant_id uuid NOT NULL
);


ALTER TABLE public.users OWNER TO screenviewer;

--
-- Data for Name: cameras; Type: TABLE DATA; Schema: public; Owner: screenviewer
--

COPY public.cameras (id, name, stream_path, go2rtc_name, dvr_channel_id, created_at, updated_at, tenant_id, dvr_id) FROM stdin;
7b177c97-211c-4df1-bf47-50c21212fdca	desktop-ql3bupt · écran 0	desktop-ql3bupt/0	desktop-ql3bupt_0	5	2026-11-13 11:59:06.004575	2026-11-13 11:59:06.004575	a3d7e3ef-1452-42a2-92ea-8e8d82c0e2e4	a14c1e0e-e238-4ae3-baa8-ec7c5db3fbb5
\.


--
-- Data for Name: dvrs; Type: TABLE DATA; Schema: public; Owner: screenviewer
--

COPY public.dvrs (id, tenant_id, name, host, username, password_enc, go2rtc_url, onvif_host, onvif_port, onvif_user, onvif_password_enc, mediamtx_rtsp_url, mediamtx_api_url, created_at, updated_at) FROM stdin;
a14c1e0e-e238-4ae3-baa8-ec7c5db3fbb5	a3d7e3ef-1452-42a2-92ea-8e8d82c0e2e4	DVR principal	192.168.8.64	screenbackend	v1:pplJ9dNIe8KKQ4jA:AIZIj8JrSypyTspHkExJAw==:y9JtEZjQBtRK	http://127.0.0.1:1984	192.168.8.246	1984	admin	v1:s698KmGZPF/ERIaa:Mitr6WW3YHknelxzDIZPJQ==:FGBLpXJQS84=	rtsp://127.0.0.1:8554	http://127.0.0.1:9997	2026-11-16 12:04:32.104216	2026-11-16 12:04:32.104216
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: screenviewer
--

COPY public.tenants (id, name, created_at) FROM stdin;
a3d7e3ef-1452-42a2-92ea-8e8d82c0e2e4	Client par defaut	2026-11-16 12:04:32.104216
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: screenviewer
--

COPY public.users (id, username, password_hash, created_at, role, tenant_id) FROM stdin;
77c17fa3-680f-4d21-adc8-1bb20a13f952	admin	$2b$12$OA3fsFSHd3lgorftqZApl.OYAiWRDqyJqYAbco1RCYva/1gegY7L6	2026-11-12 13:54:54.976122	admin	a3d7e3ef-1452-42a2-92ea-8e8d82c0e2e4
\.


--
-- Name: dvrs PK_3d0951c1bfaaee0055511fce4ee; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.dvrs
    ADD CONSTRAINT "PK_3d0951c1bfaaee0055511fce4ee" PRIMARY KEY (id);


--
-- Name: tenants PK_53be67a04681c66b87ee27c9321; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY (id);


--
-- Name: cameras PK_88b40b9817f9f422121f861e1e8; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.cameras
    ADD CONSTRAINT "PK_88b40b9817f9f422121f861e1e8" PRIMARY KEY (id);


--
-- Name: users PK_a3ffb1c0c8416b9fc6f907b7433; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);


--
-- Name: tenants UQ_32731f181236a46182a38c992a8; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT "UQ_32731f181236a46182a38c992a8" UNIQUE (name);


--
-- Name: users UQ_fe0bb3f6520ee0469504521e710; Type: CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE (username);


--
-- Name: IDX_14361d96f465343eddd0f21f64; Type: INDEX; Schema: public; Owner: screenviewer
--

CREATE UNIQUE INDEX "IDX_14361d96f465343eddd0f21f64" ON public.cameras USING btree (dvr_id, stream_path);


--
-- Name: IDX_625b025b6a6592e76c12dd404a; Type: INDEX; Schema: public; Owner: screenviewer
--

CREATE UNIQUE INDEX "IDX_625b025b6a6592e76c12dd404a" ON public.dvrs USING btree (tenant_id, name);


--
-- Name: IDX_7ecbf33644f6aaea5c50f4da3e; Type: INDEX; Schema: public; Owner: screenviewer
--

CREATE UNIQUE INDEX "IDX_7ecbf33644f6aaea5c50f4da3e" ON public.cameras USING btree (dvr_id, go2rtc_name);


--
-- Name: IDX_bffab83d2c9dfec53ec12ea9ef; Type: INDEX; Schema: public; Owner: screenviewer
--

CREATE UNIQUE INDEX "IDX_bffab83d2c9dfec53ec12ea9ef" ON public.cameras USING btree (dvr_id, dvr_channel_id);


--
-- Name: users FK_109638590074998bb72a2f2cf08; Type: FK CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "FK_109638590074998bb72a2f2cf08" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cameras FK_1d9c5274acc2913ab822c0fcf26; Type: FK CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.cameras
    ADD CONSTRAINT "FK_1d9c5274acc2913ab822c0fcf26" FOREIGN KEY (dvr_id) REFERENCES public.dvrs(id) ON DELETE RESTRICT;


--
-- Name: dvrs FK_8bfc93214b3d9f4ab73f025ec96; Type: FK CONSTRAINT; Schema: public; Owner: screenviewer
--

ALTER TABLE ONLY public.dvrs
    ADD CONSTRAINT "FK_8bfc93214b3d9f4ab73f025ec96" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict D0rBPGFJ0ho1gk1RX1SIyukccRenUVZw7leSf0tAJvJhHlNhMvLAZ82D8ne0BGo

