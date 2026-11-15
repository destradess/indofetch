# IndoFetch

Repositori 21 provider film, serial, drama Asia, dan anime untuk Nuvio TV Full di Android TV.

Di Nuvio buka **Settings → Plugins → Add repository**, lalu masukkan URL berikut.

```text
https://raw.githubusercontent.com/destradess/indofetch/main/manifest.json
```

Provider berasal dari [IndoStream](https://github.com/TeKuma25/IndoStream) dan [CloudX-V2](https://github.com/Asm0d3usX/CloudX-V2). `plugins.json` mencantumkan pengembang, versi, dan SHA-256 setiap paket. Sebelas paket di `compat/` memuat penyesuaian untuk Nuvio TV, termasuk Kotlinx Serialization 1.8.0 dari [JetBrains](https://github.com/Kotlin/kotlinx.serialization/tree/v1.8.0). Lisensi Kotlinx Serialization disertakan di paket terkait.
