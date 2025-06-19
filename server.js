// =================================================================
//      SERVER.JS (Versión sin MusicBrainz, con Autocorrección)
// =================================================================

// --- REQUIRES ---
const http = require('http');
const express = require('express');
const { Server } = require("socket.io");
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const SpotifyWebApi = require('spotify-web-api-node');
const genius = require("genius-lyrics");
const fs = require('fs').promises; // Para leer/escribir el JSON

// --- CONFIGURACIÓN BÁSICA ---
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- CONFIGURACIÓN API SPOTIFY ---
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    // MODIFICACIÓN 1: Usar la variable de entorno para la URL de callback
    redirectUri: process.env.BACKEND_URL + '/callback'
});

// --- VARIABLES GLOBALES ---
let refreshInterval = null;
let salas = {};
const letraCache = new Map();
const CORRECTIONS_DB_PATH = './corrections.json'; // Ruta para nuestra "base de datos"

// =================================================================
// --- FUNCIONES AUXILIARES ---
// =================================================================

function levenshtein(s1, s2) {
    if (s1.length < s2.length) { return levenshtein(s2, s1); }
    if (s2.length === 0) { return s1.length; }
    let previousRow = Array.from({ length: s2.length + 1 }, (_, i) => i);
    for (let i = 0; i < s1.length; i++) {
        let currentRow = [i + 1];
        for (let j = 0; j < s2.length; j++) {
            let insertions = previousRow[j + 1] + 1;
            let deletions = currentRow[j] + 1;
            let substitutions = previousRow[j] + (s1[i] !== s2[j]);
            currentRow.push(Math.min(insertions, deletions, substitutions));
        }
        previousRow = currentRow;
    }
    return previousRow[previousRow.length - 1];
}

async function getLyrics(track, artist) {
    const requestURL = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
    const response = await axios.get(requestURL, {
        timeout: 4000,
        validateStatus: () => true
    });
    if (response.status === 200 && response.data && response.data.lyrics) {
        return { source: 'lyrics.ovh', lyrics: response.data.lyrics };
    }
    return Promise.reject(`Letra no encontrada en lyrics.ovh`);
}

async function getLyricsVagalume(track, artist) {
    const requestURL = `https://api.vagalume.com.br/search.php?art=${encodeURIComponent(artist)}&mus=${encodeURIComponent(track)}&apikey=1`;
    const response = await axios.get(requestURL, {
        timeout: 4000,
        validateStatus: () => true
    });
    if (response.status === 200 && (response.data.type === 'exact' || response.data.type === 'aprox') && response.data.mus[0] && response.data.mus[0].text) {
        return { source: 'Vagalume', lyrics: response.data.mus[0].text };
    }
    return Promise.reject(`Letra no encontrada en Vagalume`);
}

const geniusClient = new genius.Client();
async function getLyricsGenius(track, artist) {
    try {
        const searches = await geniusClient.songs.search(`${track} ${artist}`);
        for (const song of searches) {
            const artistName = song.artist.name.toLowerCase();
            const searchArtist = artist.toLowerCase();
            const songTitle = song.title.toLowerCase();
            const searchTitle = track.toLowerCase();
            const artistMatch = artistName.includes(searchArtist) || searchArtist.includes(artistName);
            const titleMatch = songTitle.includes(searchTitle) || searchTitle.includes(songTitle);

            if (artistMatch && titleMatch) {
                const lyrics = await song.lyrics(false);
                if (lyrics) {
                    return { source: 'Genius', lyrics: lyrics.replace(/\[.*?\]/g, '').trim() };
                }
            }
        }
        return Promise.reject(`No se encontró letra en los resultados de Genius`);
    } catch(e) {
        return Promise.reject(`Fallo en la búsqueda de Genius para ${artist} - ${track}`);
    }
}

async function getLyricsMusixmatch(track, artist) {
    const query = `${artist} ${track}`;
    const searchUrl = `https://www.musixmatch.com/search/${encodeURIComponent(query)}`;
    try {
        const searchResponse = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const songLinkMatch = searchResponse.data.match(/"track_share_url":"([^"]+)"/);
        if (!songLinkMatch) return Promise.reject("No se encontró link de canción en Musixmatch");

        const songUrl = songLinkMatch[1].split("?")[0];
        const lyricsResponse = await axios.get(songUrl, {
             headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const lyricsMatch = lyricsResponse.data.matchAll(/"body":"([^"]+)"/g);
        let fullLyrics = "";
        for(const match of lyricsMatch) { fullLyrics += match[1]; }

        if (fullLyrics) {
            return { source: 'Musixmatch', lyrics: fullLyrics.replace(/\\n/g, '\n').replace(/\\"/g, '"') };
        }
        return Promise.reject("Letra vacía en la página de Musixmatch");
    } catch (e) {
        return Promise.reject("Error al obtener letra de Musixmatch");
    }
}

async function readCorrectionsDB() {
    try {
        await fs.access(CORRECTIONS_DB_PATH);
        const data = await fs.readFile(CORRECTIONS_DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

async function writeToCorrectionsDB(db) {
    await fs.writeFile(CORRECTIONS_DB_PATH, JSON.stringify(db, null, 2));
}

function normalizar(texto) {
    if (!texto) return '';
    return texto.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^(the|el|la|los|las)\s+/, '');
}

function generarIntentosDeTitulo(track) {
    const trackLimpio = track.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g, '');
    const intentos = new Set();
    intentos.add(trackLimpio.trim());

    const parentesisRegex = /\s*\(.*?\)|\[.*?\]/g;
    const sinParentesis = trackLimpio.replace(parentesisRegex, '').trim();
    if (sinParentesis) intentos.add(sinParentesis);
    
    if (trackLimpio.includes(' - ')) {
        const primeraParte = trackLimpio.split(' - ')[0].trim();
        if (primeraParte) intentos.add(primeraParte);
    }

    return [...intentos].filter(Boolean);
}

// =================================================================
// --- ENDPOINTS HTTP (Para autenticación y datos de Spotify) ---
// =================================================================

app.get('/login', (req, res) => {
    const scopes = ['playlist-read-private', 'playlist-read-collaborative'];
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const { error, code } = req.query;
    if (error) {
        console.error('Callback Error:', error);
        return res.send(`Callback Error: ${error}`);
    }
    spotifyApi.authorizationCodeGrant(code).then(data => {
        spotifyApi.setAccessToken(data.body['access_token']);
        spotifyApi.setRefreshToken(data.body['refresh_token']);
        console.log('¡Token de acceso a Spotify obtenido!');
        if (refreshInterval) { clearInterval(refreshInterval); }
        refreshInterval = setInterval(async () => {
            try {
                const data = await spotifyApi.refreshAccessToken();
                spotifyApi.setAccessToken(data.body['access_token']);
                console.log('El token de acceso ha sido refrescado.');
            } catch (err) {
                console.error('No se pudo refrescar el token de acceso', err);
            }
        }, (data.body['expires_in'] * 0.9) * 1000);
        // MODIFICACIÓN 2: Usar la variable de entorno para la URL del frontend
        res.redirect(process.env.FRONTEND_URL + '?login=success');
    }).catch(err => {
        console.error('Error al obtener los Tokens:', err);
        res.send(`Error al obtener los Tokens: ${err}`);
    });
});

// =================================================================
// --- LÓGICA DEL JUEGO (SOCKET.IO) ---
// =================================================================

io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    socket.on('crearSala', ({ nombre }, callback) => {
        const idSala = Math.random().toString(36).substring(2, 8).toUpperCase();
        let rondasEspeciales = ['ARTISTA_COMPLETO', 'RONDA_ALBUM', 'CONTINUACION'];
        for (let i = rondasEspeciales.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rondasEspeciales[i], rondasEspeciales[j]] = [rondasEspeciales[j], rondasEspeciales[i]];
        }
        salas[idSala] = {
            jugadores: [{ id: socket.id, nombre: nombre, puntuacion: 0, strikes: 0 }],
            pistas: [],
            rondaActual: 0,
            maxRondas: 12,
            tipoRondaActual: 'NORMAL',
            ordenRondasEspeciales: rondasEspeciales,
            temporizadorDeBorrado: null,
            propuestas: {}, respuestas: {}, asignaciones: {}
        };
        socket.join(idSala);
        socket.emit('actualizarLobby', salas[idSala].jugadores);
        callback(idSala);
    });

    socket.on('unirseSala', ({ idSala, nombre }, callback) => {
        const sala = salas[idSala];
        if (sala && sala.jugadores.length < 10) {
            if (sala.jugadores.some(j => j.id === socket.id)) {
                return callback({ exito: false, mensaje: 'Ya estás en esta sala.' });
            }
            socket.join(idSala);
            sala.jugadores.push({ id: socket.id, nombre: nombre, puntuacion: 0, strikes: 0 });
            io.to(idSala).emit('actualizarLobby', sala.jugadores);
            if (sala.pistas.length > 0) {
                socket.emit('playlistCargada', sala.pistas);
            }
            callback({ exito: true, idSala: idSala, jugadores: sala.jugadores });
        } else {
            callback({ exito: false, mensaje: 'La sala no existe o está llena' });
        }
    });

    socket.on('reconectarHost', ({ idSala, nombre }, callback) => {
        const sala = salas[idSala];
        if (sala) {
            if (sala.temporizadorDeBorrado) {
                clearTimeout(sala.temporizadorDeBorrado);
                sala.temporizadorDeBorrado = null;
            }
            if (sala.jugadores.length > 0) {
                sala.jugadores[0].id = socket.id;
                sala.jugadores[0].nombre = nombre;
            } else {
                sala.jugadores.push({ id: socket.id, nombre: nombre, puntuacion: 0 });
            }
            socket.join(idSala);
            io.to(idSala).emit('actualizarLobby', sala.jugadores);
            callback({ exito: true });
        } else {
            callback({ exito: false, mensaje: 'La sala no se encontró.' });
        }
    });
    
    socket.on('solicitarPlaylists', async () => {
        try {
            const data = await spotifyApi.getUserPlaylists({ limit: 50 });
            socket.emit('playlistsRecibidas', data.body.items);
        } catch (err) {
            console.error('[SERVIDOR] Error en solicitarPlaylists:', err);
            socket.emit('error', 'No se pudieron cargar tus playlists de Spotify.');
        }
    });

    socket.on('playlistSeleccionada', async ({ idSala, playlistId }) => {
        const sala = salas[idSala];
        if (!sala) return;
        let exito = false;
        for (let i = 0; i < 3; i++) {
            try {
                const data = await spotifyApi.getPlaylistTracks(playlistId, { fields: 'items(track(name,artists(name),album(id,name,release_date,images)))' });
                sala.pistas = data.body.items.filter(item => item && item.track && item.track.name && item.track.album && item.track.album.images.length > 0);
                io.to(idSala).emit('playlistCargada', sala.pistas);
                exito = true;
                break; 
            } catch (err) {
                console.error(`[SERVIDOR] Intento ${i + 1} fallido al obtener tracks:`, err.message);
                if (i < 2) await new Promise(res => setTimeout(res, 1000));
            }
        }
        if (!exito) {
            console.error(`[SERVIDOR] Error final al obtener tracks para la sala ${idSala} después de 3 intentos.`);
            socket.emit('errorAlCargarPlaylist', 'No se pudieron cargar las canciones de la playlist tras varios intentos.');
        }
    });

    socket.on('empezarPartida', (idSala) => {
        const sala = salas[idSala];
        if (!sala) return;
        sala.rondaActual++;
        if (sala.rondaActual > sala.maxRondas) {
            sala.jugadores.forEach(jugador => {
                if (jugador.strikes >= 3) {
                    console.log(`[PENALIZACIÓN] El jugador ${jugador.nombre} pierde 10 puntos por acumular ${jugador.strikes} strikes.`);
                    jugador.puntuacion -= 10;
                }
            });
            io.to(idSala).emit('finDelJuego', sala.jugadores);
            return;
        }
        sala.propuestas = {};
        sala.respuestas = {};
        sala.asignaciones = {};
        if (sala.rondaActual === 4 || sala.rondaActual === 8 || sala.rondaActual === 12) {
            const indexEspecial = Math.floor((sala.rondaActual / 4) - 1);
            sala.tipoRondaActual = sala.ordenRondasEspeciales[indexEspecial];
        } else {
            sala.tipoRondaActual = 'NORMAL';
        }
        io.to(idSala).emit('iniciarNuevaRonda', {
            numero: sala.rondaActual,
            tipo: sala.tipoRondaActual,
            maxRondas: sala.maxRondas
        });
    });

    socket.on('solicitarLetra', async ({ track, artist }) => {
        const originalQueryKey = `${normalizar(track)}|${normalizar(artist)}`;
        
        const correctionsDB = await readCorrectionsDB();
        if (correctionsDB[originalQueryKey]) {
            console.log(`[AUTOCORRECCIÓN] Sirviendo letra para '${track}' desde DB JSON.`);
            socket.emit('letraRecibida', correctionsDB[originalQueryKey]);
            return;
        }

        if (letraCache.has(originalQueryKey)) {
            console.log(`[CACHE HIT] Sirviendo letra para '${track}' desde caché de sesión.`);
            socket.emit('letraRecibida', letraCache.get(originalQueryKey));
            return;
        }
        
        console.log(`[BÚSQUEDA] Iniciando para '${track}' de '${artist}'`);

        const runSearch = async (titles, artists) => {
            const promises = [];
            for (const t of titles) {
                for (const a of artists) {
                    promises.push(getLyrics(t, a));
                    promises.push(getLyricsVagalume(t, a));
                    promises.push(getLyricsGenius(t, a));
                    promises.push(getLyricsMusixmatch(t, a));
                }
            }
            if (promises.length === 0) return null;
            
            const settledResults = await Promise.allSettled(promises);
            for (const result of settledResults) {
                if (result.status === 'fulfilled') {
                    return result.value;
                }
            }
            return null;
        };

        try {
            let resultado = null;

            console.log("[BÚSQUEDA] Oleada 1 (Alta Prioridad)...");
            resultado = await runSearch([track], [artist]);

            if (!resultado) {
                console.log("[BÚSQUEDA] Oleada 2 (Extensiva)...");
                const separadores = /,|&|\band\b|feat|ft/i;
                const listaArtistas = new Set(artist.split(separadores).map(a => a.trim()).filter(Boolean));
                listaArtistas.add(artist.trim());
                const intentosDeTitulo = generarIntentosDeTitulo(track);
                resultado = await runSearch(intentosDeTitulo, [...listaArtistas]);
            }

            if (resultado && resultado.lyrics) {
                console.log(`[ÉXITO] Letra encontrada por [${resultado.source}]`);
                letraCache.set(originalQueryKey, resultado.lyrics);
                socket.emit('letraRecibida', resultado.lyrics);
            } else {
                throw new Error("Todas las oleadas de búsqueda fallaron.");
            }
        } catch (error) {
             console.log(`[FALLO] No se encontró la letra. Preparando para posible autocorrección.`);
             const sala = Object.values(salas).find(s => s.jugadores.some(j => j.id === socket.id));
             if (sala) {
                 const jugador = sala.jugadores.find(j => j.id === socket.id);
                 if (jugador) {
                     jugador.lastFailedQuery = { track, artist };
                 }
             }
             socket.emit('letraRecibida', null);
        }
    });

    socket.on('enviarMensajeChat', ({ idSala, mensaje }) => {
        const sala = salas[idSala];
        if (sala) {
            const jugador = sala.jugadores.find(j => j.id === socket.id);
            if (jugador) {
                io.to(idSala).emit('nuevoMensajeChat', { 
                    nombre: jugador.nombre, 
                    mensaje: mensaje 
                });
            }
        }
    });

    socket.on('enviarPropuesta', async ({ idSala, propuesta }) => {
        const sala = salas[idSala];
        if (sala) {
            const jugador = sala.jugadores.find(j => j.id === socket.id);
            if (jugador && jugador.lastFailedQuery) {
                console.log(`[AUTOCORRECCIÓN] Se ha detectado una propuesta manual para un fallo anterior.`);
                const key = `${normalizar(jugador.lastFailedQuery.track)}|${normalizar(jugador.lastFailedQuery.artist)}`;
                const correctionsDB = await readCorrectionsDB();
                
                const letraCorregida = propuesta.versos; 

                if (letraCorregida && !correctionsDB[key]) {
                    correctionsDB[key] = letraCorregida;
                    await writeToCorrectionsDB(correctionsDB);
                    console.log(`[AUTOCORRECCIÓN] Nueva regla guardada para '${key}'`);
                }
                delete jugador.lastFailedQuery;
            }

            sala.propuestas[socket.id] = propuesta;
            io.to(idSala).emit('propuestaRecibida', socket.id);
            if (Object.keys(sala.propuestas).length === sala.jugadores.length) {
                io.to(idSala).emit('empezarFaseAdivinanza');
            }
        }
    });

    socket.on('distribuirRetos', (idSala) => {
        const sala = salas[idSala];
        if (!sala) return;
        const jugadores = sala.jugadores.map(j => j.id);
        const propuestas = sala.propuestas;
        let receptores = [...jugadores];
        for (let i = receptores.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [receptores[i], receptores[j]] = [receptores[j], receptores[i]];
        }
        for (let i = 0; i < jugadores.length; i++) {
            if (jugadores[i] === receptores[i]) {
                const sig = (i + 1) % jugadores.length;
                [receptores[i], receptores[sig]] = [receptores[sig], receptores[i]];
            }
        }
        for (let i = 0; i < jugadores.length; i++) {
            const idJugadorQueAdivina = jugadores[i];
            const idJugadorQuePropuso = receptores[i];
            sala.asignaciones[idJugadorQueAdivina] = idJugadorQuePropuso;
            const propuestaAsignada = propuestas[idJugadorQuePropuso];
            const pistaOriginal = sala.pistas.find(p => p.track.name === propuestaAsignada.cancion);
            let reto = {
                dificultad: propuestaAsignada.dificultad,
                tipo: sala.tipoRondaActual
            };
            if (sala.tipoRondaActual === 'RONDA_ALBUM' && pistaOriginal) {
                reto.caratulaUrl = pistaOriginal.track.album.images[0].url;
            } else {
                reto.versos = propuestaAsignada.versos;
            }
            io.to(idJugadorQueAdivina).emit('recibirReto', reto);
        }
    });

    socket.on('enviarRespuesta', async ({ idSala, respuesta }) => {
        const sala = salas[idSala];
        if (sala && sala.respuestas) {
            sala.respuestas[socket.id] = respuesta;
            if (Object.keys(sala.respuestas).length === sala.jugadores.length) {
                const resultadosRonda = [];
                for (const jugador of sala.jugadores) {
                    const idJugadorQueAdivina = jugador.id;
                    const idJugadorQuePropuso = sala.asignaciones[idJugadorQueAdivina];
                    
                    // =======================================================
                    // =============== INICIO DE LA CORRECCIÓN ===============
                    // =======================================================
                    // ANTES (Incorrecto): Se usaba la propuesta del jugador que adivinaba
                    // const propuestaOriginal = sala.propuestas[idJugadorQueAdivina];
                    
                    // AHORA (Correcto): Usamos la propuesta del jugador que propuso el reto
                    const propuestaOriginal = sala.propuestas[idJugadorQuePropuso];
                    // =======================================================
                    // ================= FIN DE LA CORRECCIÓN ================
                    // =======================================================

                    const pistaOriginal = sala.pistas.find(p => p.track.name === propuestaOriginal.cancion);
                    if (!pistaOriginal) continue;
                    const respuestaJugador = sala.respuestas[idJugadorQueAdivina];
                    let puntosGanados = 0;
                    let aciertos = {};

                    const umbralFuzzy = 2;

                    if (sala.tipoRondaActual === 'CONTINUACION') {
                        aciertos.cancion = levenshtein(normalizar(pistaOriginal.track.name), normalizar(respuestaJugador.cancion)) <= umbralFuzzy;
                        const artistasCorrectos = propuestaOriginal.artista.split(',').map(a => normalizar(a));
                        aciertos.artista = artistasCorrectos.some(a => levenshtein(a, normalizar(respuestaJugador.artista)) <= umbralFuzzy);
                        aciertos.siguienteVerso = levenshtein(normalizar(propuestaOriginal.siguienteVerso), normalizar(respuestaJugador.siguienteVerso)) <= 4;
                        
                        if (aciertos.cancion) puntosGanados += 2;
                        if (aciertos.artista) puntosGanados += 2;
                        if (aciertos.siguienteVerso) {
                            if (propuestaOriginal.dificultad === 'facil') puntosGanados += 1;
                            if (propuestaOriginal.dificultad === 'media') puntosGanados += 2;
                            if (propuestaOriginal.dificultad === 'dificil') puntosGanados += 3;
                        }
                    } else if (sala.tipoRondaActual === 'RONDA_ALBUM') {
                        aciertos.album = levenshtein(normalizar(pistaOriginal.track.album.name), normalizar(respuestaJugador.album)) <= umbralFuzzy;
                        aciertos.artista = levenshtein(normalizar(pistaOriginal.track.artists[0].name), normalizar(respuestaJugador.artista)) <= umbralFuzzy;
                        aciertos.ano = pistaOriginal.track.album.release_date.substring(0, 4) === respuestaJugador.ano;
                        const albumTracksData = await spotifyApi.getAlbumTracks(pistaOriginal.track.album.id);
                        const nombresDeCanciones = albumTracksData.body.items.map(t => normalizar(t.name));
                        aciertos.cancionDeAlbum = nombresDeCanciones.some(c => levenshtein(c, normalizar(respuestaJugador.cancion)) <= umbralFuzzy);

                        if(aciertos.album) puntosGanados += 2;
                        if(aciertos.artista) puntosGanados += 2;
                        if(aciertos.cancionDeAlbum) puntosGanados += 2;
                        if(respuestaJugador.ano && respuestaJugador.ano.trim() !== '') {
                            puntosGanados += aciertos.ano ? 2 : -1;
                        }
                    } else if (sala.tipoRondaActual === 'ARTISTA_COMPLETO') {
                        aciertos.cancion = levenshtein(normalizar(pistaOriginal.track.name), normalizar(respuestaJugador.cancion)) <= umbralFuzzy;
                        const artistasCorrectos = pistaOriginal.track.artists.map(a => normalizar(a.name)).sort();
                        const artistasAdivinados = respuestaJugador.artista.split(',').map(a => normalizar(a)).sort();
                        aciertos.artista = JSON.stringify(artistasCorrectos) === JSON.stringify(artistasAdivinados);
                        aciertos.album = levenshtein(normalizar(pistaOriginal.track.album.name), normalizar(respuestaJugador.album)) <= umbralFuzzy;
                        aciertos.ano = pistaOriginal.track.album.release_date.substring(0, 4) === respuestaJugador.ano;
                        
                        if (aciertos.cancion) puntosGanados += 2;
                        if (aciertos.artista) puntosGanados += 1;
                        if(aciertos.album) puntosGanados += 1;
                        if(aciertos.ano) puntosGanados += 1;
                    } else { // Rondas normales
                        aciertos.cancion = levenshtein(normalizar(propuestaOriginal.cancion), normalizar(respuestaJugador.cancion)) <= umbralFuzzy;
                        const artistasCorrectos = propuestaOriginal.artista.split(',').map(a => normalizar(a));
                        aciertos.artista = artistasCorrectos.some(a => levenshtein(a, normalizar(respuestaJugador.artista)) <= umbralFuzzy);

                        if (aciertos.cancion) {
                            if (propuestaOriginal.dificultad === 'facil') puntosGanados += 1;
                            if (propuestaOriginal.dificultad === 'media') puntosGanados += 3;
                            if (propuestaOriginal.dificultad === 'dificil') puntosGanados += 4;
                        }
                        if (aciertos.artista) {
                            if (propuestaOriginal.dificultad === 'facil' || propuestaOriginal.dificultad === 'media') puntosGanados += 1;
                            if (propuestaOriginal.dificultad === 'dificil') puntosGanados += 2;
                        }
                    }
                    jugador.puntuacion += puntosGanados;
                    resultadosRonda.push({
                        nombreAdivinador: jugador.nombre,
                        propuestaDe: sala.jugadores.find(j => j.id === idJugadorQuePropuso).nombre,
                        cancionOriginal: pistaOriginal.track.name,
                        albumOriginal: pistaOriginal.track.album.name,
                        artistaOriginal: pistaOriginal.track.artists.map(a => a.name).join(', '),
                        siguienteVersoOriginal: propuestaOriginal.siguienteVerso,
                        puntos: puntosGanados,
                        tipoRonda: sala.tipoRondaActual,
                        aciertos
                    });
                }
                io.to(idSala).emit('finalDeRonda', { 
                    resultadosRonda, 
                    puntuacionesGenerales: sala.jugadores,
                    esRondaFinal: sala.rondaActual === sala.maxRondas 
                });
            }
        }
    });
    
    socket.on('reportarJugador', ({ idSala }) => {
        const sala = salas[idSala];
        if (!sala || !sala.asignaciones) return;
        const idReportado = sala.asignaciones[socket.id];
        if (!idReportado) return;
        const jugadorReportado = sala.jugadores.find(j => j.id === idReportado);
        if (jugadorReportado) {
            jugadorReportado.strikes = (jugadorReportado.strikes || 0) + 1;
            console.log(`[STRIKE] Jugador ${jugadorReportado.nombre} (${idReportado}) ha recibido un strike. Total: ${jugadorReportado.strikes}`);
            io.to(idReportado).emit('recibirStrike', { strikesActuales: jugadorReportado.strikes });
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);
        for (const idSala in salas) {
            const sala = salas[idSala];
            const jugadorIndex = sala.jugadores.findIndex(j => j.id === socket.id);
            if (jugadorIndex > -1) {
                sala.jugadores.splice(jugadorIndex, 1);
                if (sala.jugadores.length === 0) {
                    sala.temporizadorDeBorrado = setTimeout(() => {
                        if (salas[idSala] && salas[idSala].jugadores.length === 0) {
                            delete salas[idSala];
                        }
                    }, 15000);
                } else {
                    io.to(idSala).emit('actualizarLobby', sala.jugadores);
                }
                break;
            }
        }
    });
});

// MODIFICACIÓN 3: Usar el puerto de la variable de entorno, o 3001 como alternativa
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});