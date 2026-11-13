/** Réglages DVR / go2rtc / MediaMTX lus depuis l'environnement (.env). */
export interface NvrSettings {
  dvrHost: string;
  dvrUser: string;
  dvrPassword: string;
  go2rtcUrl: string;
  /** Adresse de go2rtc telle que le DVR la joint (IP LAN, pas 127.0.0.1). */
  go2rtcOnvifHost: string;
  go2rtcOnvifPort: number;
  go2rtcOnvifUser: string;
  go2rtcOnvifPassword: string;
  /** Base RTSP de MediaMTX vue par go2rtc, ex. rtsp://127.0.0.1:8554 */
  mediamtxRtspUrl: string;
}

export function nvrSettings(env: NodeJS.ProcessEnv = process.env): NvrSettings {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} manquant dans .env`);
    return v;
  };
  return {
    dvrHost: need("DVR_HOST"),
    dvrUser: need("DVR_USER"),
    dvrPassword: need("DVR_PASSWORD"),
    go2rtcUrl: env.GO2RTC_URL ?? "http://127.0.0.1:1984",
    go2rtcOnvifHost: need("GO2RTC_ONVIF_HOST"),
    go2rtcOnvifPort: Number(env.GO2RTC_ONVIF_PORT ?? 1984),
    go2rtcOnvifUser: env.GO2RTC_ONVIF_USER ?? "admin",
    go2rtcOnvifPassword: need("GO2RTC_ONVIF_PASSWORD"),
    mediamtxRtspUrl: env.MEDIAMTX_RTSP_URL ?? "rtsp://127.0.0.1:8554",
  };
}
