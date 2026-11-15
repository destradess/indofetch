# IndoFetch

Repositori provider untuk Nuvio Desktop dan Nuvio TV Full.

Di **Settings → Plugins → Add repository**, pilih URL sesuai aplikasi yang dipakai.

- **Nuvio Desktop dan Nuvio TV Full di Android TV** bisa memakai [`manifest.json`](https://raw.githubusercontent.com/destradess/indofetch/refs/heads/main/manifest.json) dengan provider JavaScript **LK21** untuk film.
- **Nuvio TV Full di Android TV** juga bisa memakai [`repo.json`](https://raw.githubusercontent.com/destradess/indofetch/refs/heads/main/repo.json) dengan 21 provider CloudStream untuk film, serial, drama Asia, dan anime.

Di **Settings → Plugins**, aktifkan **Group plugin providers by repository** agar **IndoFetch** menjadi nama grup di pemilihan stream dan **LK21** tampil sebagai sumbernya.

Provider berasal dari [IndoStream](https://github.com/TeKuma25/IndoStream) dan [CloudX-V2](https://github.com/Asm0d3usX/CloudX-V2). `plugins.json` mencantumkan pengembang, versi, dan SHA-256 setiap paket. Sebelas paket di `compat/` memuat penyesuaian untuk Nuvio TV, termasuk Kotlinx Serialization 1.8.0 dari [JetBrains](https://github.com/Kotlin/kotlinx.serialization/tree/v1.8.0). Lisensi Kotlinx Serialization disertakan di paket terkait.
