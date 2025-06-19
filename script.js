const socket = io("https://song-tussle.onrender.com");

const pantallas = {
    inicio: document.getElementById('pantalla-inicio'),
    lobby: document.getElementById('lobby'),
    playlist: document.getElementById('seccion-playlist'),
    cancionAleatoria: document.getElementById('seccion-cancion-aleatoria'),
    mostrarLetra: document.getElementById('seccion-mostrar-letra'),
    proponer: document.getElementById('seccion-proponer'),
    adivinar: document.getElementById('seccion-adivinar'),
    resultados: document.getElementById('seccion-resultados'),
    anuncioRonda: document.getElementById('seccion-anuncio-ronda'),
    finJuego: document.getElementById('seccion-fin-juego'),
};

const chatContainer = document.getElementById('chat-container');
const chatToggle = document.getElementById('chat-toggle');
const chatWindow = document.getElementById('chat-window');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatUnreadDot = document.getElementById('chat-unread-dot');

let miNombre = '', miSalaId = null, esAnfitrion = false;
let pistasDeLaPlaylist = [], cancionActual = null, tipoRondaActual = 'NORMAL';
let audioContext;
let faseSeleccion = 'versos';

// 1. Centralizamos la lógica de inicialización de audio
function inicializarAudio() {
    if (audioContext && audioContext.state === 'running') return; // Si ya está activo, no hacemos nada

    if (!audioContext) {
        try {
            console.log("Creando AudioContext...");
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch(e) {
            console.error("El navegador no soporta AudioContext", e);
            return; // Salimos si no se puede crear
        }
    }
    
    // Si está suspendido (estado típico antes del primer clic), lo reanudamos
    if (audioContext.state === 'suspended') {
        console.log("Intentando reanudar AudioContext...");
        audioContext.resume().catch(e => console.error("Error al reanudar AudioContext:", e));
    }
}

// 2. Nos aseguramos de que se ejecute en la primera interacción del usuario
document.body.addEventListener('click', inicializarAudio, { once: true });
document.body.addEventListener('keydown', inicializarAudio, { once: true });


function mostrarPantalla(nombrePantalla) {
    document.querySelectorAll('.caja-juego.active').forEach(caja => {
        caja.classList.remove('active');
        setTimeout(() => {
            if (!caja.classList.contains('active')) {
                caja.style.display = 'none';
            }
        }, 500);
    });

    const pantallaAMostrar = pantallas[nombrePantalla];
    if (pantallaAMostrar) {
        pantallaAMostrar.style.display = 'flex';
        setTimeout(() => {
            pantallaAMostrar.classList.add('active');
        }, 20);
    }
}


function actualizarLobbyUI(jugadores) {
    const lista = document.getElementById('lista-jugadores');
    lista.innerHTML = '';
    jugadores.forEach(jugador => {
        const li = document.createElement('li');
        li.innerText = `${jugador.nombre} - ${jugador.puntuacion || 0} pts (${jugador.strikes || 0} strikes) ${jugador.id === socket.id ? ' (Tú)' : ''}`;
        lista.appendChild(li);
    });

    const statusMsg = document.getElementById('status-playlist');
    if (!esAnfitrion && jugadores.length > 0) {
        const hostNombre = jugadores[0].nombre;
        statusMsg.innerText = `Esperando a que ${hostNombre} elija una playlist e inicie la partida...`;
        statusMsg.style.display = 'block';
    } else if (esAnfitrion && !pistasDeLaPlaylist.length) {
         statusMsg.innerText = `Como anfitrión, debes conectar Spotify y elegir una playlist para empezar.`;
         statusMsg.style.display = 'block';
    }
}

function entrarAlLobby(idSala) {
    miSalaId = idSala;
    mostrarPantalla('lobby');
    document.getElementById('codigo-sala').innerText = idSala;
    
    const btnSpotify = document.getElementById('btn-conectar-spotify');
    if (esAnfitrion) {
        btnSpotify.style.display = 'inline-flex';
    } else {
        btnSpotify.style.display = 'none';
    }
}

window.addEventListener('load', () => {
    mostrarPantalla('inicio');

    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'success') {
        const idSalaGuardado = sessionStorage.getItem('salaHost');
        const nombreGuardado = sessionStorage.getItem('nombreHost');
        if (idSalaGuardado && nombreGuardado) {
            miSalaId = idSalaGuardado;
            miNombre = nombreGuardado;
            esAnfitrion = true;
            socket.emit('reconectarHost', { idSala: idSalaGuardado, nombre: miNombre }, (res) => {
                if (res.exito) {
                    entrarAlLobby(idSalaGuardado);
                    mostrarPantalla('playlist');
                    socket.emit('solicitarPlaylists');
                } else {
                    alert(res.mensaje || 'Error al reconectar a la sala.');
                    mostrarPantalla('inicio');
                }
            });
            sessionStorage.removeItem('salaHost');
            sessionStorage.removeItem('nombreHost');
        }
        window.history.pushState({}, document.title, window.location.pathname);
    }
});

document.getElementById('btn-continuar-nombre').addEventListener('click', () => {
    inicializarAudio();
    
    miNombre = document.getElementById('input-nombre').value;
    if (!miNombre.trim()) { return alert('Por favor, introduce un nombre.'); }
    document.getElementById('paso-nombre').style.display = 'none';
    document.getElementById('opciones-sala').style.display = 'block';
    document.getElementById('nombre-saludo').innerText = miNombre;
});

document.getElementById('btn-crear').addEventListener('click', () => {
    esAnfitrion = true;
    socket.emit('crearSala', { nombre: miNombre }, (id) => {
        sessionStorage.setItem('salaJuego', id);
        sessionStorage.setItem('nombreJuego', miNombre);
        entrarAlLobby(id);
        actualizarLobbyUI([{ nombre: miNombre, puntuacion: 0, id: socket.id, strikes: 0 }]);
    });
});

document.getElementById('btn-unirse').addEventListener('click', () => {
    const boton = document.getElementById('btn-unirse');
    const idSala = document.getElementById('input-sala').value.toUpperCase();
    if (!miNombre.trim() || !idSala) { return alert('Introduce tu nombre y el código de la sala.'); }
    boton.disabled = true;
    boton.innerText = 'UNIÉNDOSE...';
    socket.emit('unirseSala', { idSala, nombre: miNombre }, (res) => {
        if (res.exito) {
            sessionStorage.setItem('salaJuego', res.idSala);
            sessionStorage.setItem('nombreJuego', miNombre);
            entrarAlLobby(res.idSala);
        } else {
            document.getElementById('error-sala').innerText = res.mensaje;
            boton.disabled = false;
            boton.innerText = 'Unirse a Sala';
        }
    });
});

document.getElementById('btn-conectar-spotify').addEventListener('click', () => {
    sessionStorage.setItem('salaHost', miSalaId);
    sessionStorage.setItem('nombreHost', miNombre);
    window.location.href = 'https://song-tussle.onrender.com/login';
});

socket.on('playlistsRecibidas', (playlists) => {
    const select = document.getElementById('lista-playlists');
    select.innerHTML = '<option value="">-- Selecciona una playlist --</option>';
    playlists.forEach(p => {
        if (p.name) {
            const option = document.createElement('option');
            option.value = p.id;
            option.innerText = p.name;
            select.appendChild(option);
        }
    });
});

document.getElementById('btn-confirmar-playlist').addEventListener('click', () => {
    const boton = document.getElementById('btn-confirmar-playlist');
    const playlistId = document.getElementById('lista-playlists').value;
    if (!playlistId) return alert("Por favor, selecciona una playlist.");
    boton.disabled = true;
    boton.innerHTML = '<span class="loader"></span> CARGANDO...';
    socket.emit('playlistSeleccionada', { idSala: miSalaId, playlistId });
});

socket.on('playlistCargada', (pistas) => {
    pistasDeLaPlaylist = pistas;
    const botonConfirmar = document.getElementById('btn-confirmar-playlist');
    const statusMsg = document.getElementById('status-playlist');
    if (esAnfitrion) {
        entrarAlLobby(miSalaId);
        document.getElementById('btn-empezar-partida').style.display = 'block';
        statusMsg.innerText = `¡Playlist cargada con ${pistas.length} canciones! Listo para empezar.`;
        statusMsg.style.display = 'block';
    }
    botonConfirmar.disabled = false;
    botonConfirmar.textContent = 'Confirmar Playlist';
});

socket.on('errorAlCargarPlaylist', (mensaje) => {
    alert(mensaje);
    const botonConfirmar = document.getElementById('btn-confirmar-playlist');
    botonConfirmar.disabled = false;
    botonConfirmar.textContent = 'Confirmar Playlist';
    if(esAnfitrion) {
        mostrarPantalla('lobby');
    }
});

socket.on('actualizarLobby', (jugadores) => {
    actualizarLobbyUI(jugadores);
});

document.getElementById('btn-empezar-partida').addEventListener('click', () => {
    socket.emit('empezarPartida', miSalaId);
});
document.getElementById('btn-siguiente-ronda').addEventListener('click', () => {
    socket.emit('empezarPartida', miSalaId);
});
document.getElementById('btn-volver-lobby-resultados').addEventListener('click', () => {
    mostrarPantalla('lobby');
});
document.getElementById('btn-jugar-otra-vez').addEventListener('click', () => {
    window.location.reload();
});

socket.on('iniciarNuevaRonda', ({ numero, tipo, maxRondas }) => {
    tipoRondaActual = tipo;
    document.getElementById('anuncio-numero-ronda').innerText = `RONDA ${numero} / ${maxRondas}`;
    let nombreTipo = tipo.replace(/_/g, ' ');
    document.getElementById('anuncio-tipo-ronda').innerText = nombreTipo;
    mostrarPantalla('anuncioRonda');
    setTimeout(() => {
        mostrarCancionAleatoria();
    }, 3500);
});

socket.on('finDelJuego', (puntuacionesGenerales) => {
    const puntuacionesUl = document.getElementById('lista-puntuaciones-final');
    puntuacionesUl.innerHTML = '';
    puntuacionesGenerales.sort((a, b) => b.puntuacion - a.puntuacion).forEach((jugador, index) => {
        const li = document.createElement('li');
        const medalla = index === 0 ? '🥇' : (index === 1 ? '🥈' : (index === 2 ? '🥉' : ''));
        let textoPenalizacion = '';
        if (jugador.strikes >= 3) {
            textoPenalizacion = ` (Penalizado por ${jugador.strikes} strikes)`;
        }
        li.innerHTML = `<span>${medalla} ${jugador.nombre}</span> <span>${jugador.puntuacion} puntos${textoPenalizacion}</span>`;
        puntuacionesUl.appendChild(li);
    });
    mostrarPantalla('finJuego');
});

function mostrarCancionAleatoria() {
    const btnSeleccionar = document.getElementById('btn-seleccionar-cancion');
    const btnOmitir = document.getElementById('btn-omitir-cancion');
    if (btnSeleccionar) {
        btnSeleccionar.disabled = false;
        btnSeleccionar.innerText = 'Seleccionar Esta Canción';
    }
    if (btnOmitir) {
        btnOmitir.disabled = false;
    }

    if (pistasDeLaPlaylist.length === 0) {
        alert("No hay canciones en la playlist.");
        if (esAnfitrion) mostrarPantalla('playlist');
        else mostrarPantalla('lobby');
        return;
    }
    const cancionRandom = pistasDeLaPlaylist[Math.floor(Math.random() * pistasDeLaPlaylist.length)];
    if (!cancionRandom || !cancionRandom.track) {
        return mostrarCancionAleatoria();
    }
    cancionActual = {
        track: cancionRandom.track.name,
        artist: cancionRandom.track.artists.map(a => a.name).join(', '),
        album: cancionRandom.track.album.name,
        year: cancionRandom.track.album.release_date.substring(0, 4)
    };
    document.getElementById('info-cancion').innerHTML = `<h4>${cancionActual.track}</h4><p>de ${cancionActual.artist}</p>`;
    mostrarPantalla('cancionAleatoria');
}

document.getElementById('btn-omitir-cancion').addEventListener('click', mostrarCancionAleatoria);

document.getElementById('btn-seleccionar-cancion').addEventListener('click', () => {
    if (cancionActual) {
        const btnSeleccionar = document.getElementById('btn-seleccionar-cancion');
        const btnOmitir = document.getElementById('btn-omitir-cancion');
        btnSeleccionar.disabled = true;
        btnOmitir.disabled = true;
        btnSeleccionar.innerText = 'BUSCANDO LETRA...';
        socket.emit('solicitarLetra', cancionActual);
    }
});

socket.on('letraRecibida', (lyrics) => {
    mostrarPantalla('mostrarLetra');

    const btnSeleccionar = document.getElementById('btn-seleccionar-cancion');
    btnSeleccionar.disabled = false;
    btnSeleccionar.innerText = 'Seleccionar Esta Canción';

    const lyricsContainer = document.getElementById('lyrics-container');
    const mensajeManual = document.getElementById('mensaje-letra-manual');
    const btnFijar = document.getElementById('btn-fijar-versos');
    const btnProponer = document.getElementById('btn-ir-a-proponer');
    const instruccion = document.getElementById('instruccion-seleccion');
    const titulo = document.getElementById('titulo-seleccion-versos');

    lyricsContainer.innerHTML = '';
    faseSeleccion = 'versos'; 

    if (lyrics) {
        mensajeManual.style.display = 'none';
        const lineas = lyrics.split('\n');
        lineas.forEach(linea => {
            if (linea.trim() !== '') {
                const p = document.createElement('p');
                p.textContent = linea;
                p.classList.add('lyric-line');
                p.addEventListener('click', () => handleLineClick(p));
                lyricsContainer.appendChild(p);
            }
        });
    } else {
        mensajeManual.style.display = 'block';
        mensajeManual.textContent = 'No se encontró la letra. Por favor, pégala aquí manualmente.';
        const textareaManual = document.createElement('textarea');
        textareaManual.placeholder = 'Pega aquí la letra completa...';
        textareaManual.id = 'letra-manual-input';
        lyricsContainer.appendChild(textareaManual);
    }

    if (tipoRondaActual === 'CONTINUACION') {
        titulo.innerText = 'Elige los Versos';
        instruccion.innerText = 'Selecciona los versos para el reto.';
        btnFijar.style.display = 'inline-block';
        btnProponer.style.display = 'none';
    } else {
        titulo.innerText = 'Elige los Versos';
        instruccion.innerText = 'Selecciona las líneas para tu reto.';
        btnFijar.style.display = 'none';
        btnProponer.style.display = 'inline-block';
    }
});

function handleLineClick(pElement) {
    if (tipoRondaActual === 'CONTINUACION' && faseSeleccion === 'respuesta') {
        if (pElement.classList.contains('selected')) return; 

        const respuestaActual = document.querySelector('.lyric-line.respuesta-seleccionada');
        if (respuestaActual) {
            respuestaActual.classList.remove('respuesta-seleccionada');
        }
        pElement.classList.add('respuesta-seleccionada');
    } else {
        pElement.classList.toggle('selected');
    }
}

document.getElementById('btn-fijar-versos').addEventListener('click', () => {
    const seleccionadas = document.querySelectorAll('.lyric-line.selected');
    if (seleccionadas.length === 0) {
        return alert("Debes seleccionar al menos un verso para el reto.");
    }
    faseSeleccion = 'respuesta';
    document.getElementById('titulo-seleccion-versos').innerText = 'Elige la Respuesta';
    document.getElementById('instruccion-seleccion').innerText = 'Ahora, haz clic en la línea que va JUSTO DESPUÉS.';
    document.getElementById('btn-fijar-versos').style.display = 'none';
    document.getElementById('btn-ir-a-proponer').style.display = 'inline-block';
});

document.getElementById('btn-ir-a-proponer').addEventListener('click', () => {
    let textoPropuesta = [];
    let textoRespuesta = '';

    const textareaManual = document.getElementById('letra-manual-input');
    if (textareaManual) {
        if (!textareaManual.value.trim()) {
            return alert("Debes pegar la letra antes de proponer un reto.");
        }
        textoPropuesta = [textareaManual.value];
    } else {
        const versosSeleccionados = document.querySelectorAll('.lyric-line.selected');
        if (versosSeleccionados.length === 0) {
            return alert("Debes seleccionar al menos un verso para tu reto.");
        }
        versosSeleccionados.forEach(v => textoPropuesta.push(v.textContent));

        if (tipoRondaActual === 'CONTINUACION') {
            const respuestaSeleccionada = document.querySelector('.lyric-line.respuesta-seleccionada');
            if (!respuestaSeleccionada) {
                return alert("Por favor, selecciona la línea de respuesta para la ronda de continuación.");
            }
            textoRespuesta = respuestaSeleccionada.textContent;
        }
    }
    
    mostrarPantalla('proponer');
    
    document.getElementById('prop-cancion').value = cancionActual.track;
    document.getElementById('prop-artista').value = cancionActual.artist;
    
    if (textareaManual) {
        document.getElementById('prop-versos').value = '';
        document.getElementById('prop-versos').placeholder = 'Copia de la letra que pegaste los versos que quieres usar.';
    } else {
        document.getElementById('prop-versos').value = textoPropuesta.join('\n');
    }

    const campoSiguienteVerso = document.getElementById('campo-siguiente-verso');
    const inputSiguienteVerso = document.getElementById('prop-siguiente-verso');

    if (tipoRondaActual === 'CONTINUACION') {
        campoSiguienteVerso.style.display = 'block';
        inputSiguienteVerso.value = textoRespuesta;
    } else {
        campoSiguienteVerso.style.display = 'none';
        inputSiguienteVerso.value = '';
    }
    
    document.getElementById('btn-enviar-propuesta').disabled = false;
    document.getElementById('esperando-propuestas').style.display = 'none';
});

document.getElementById('btn-enviar-propuesta').addEventListener('click', () => {
    const propuesta = {
        cancion: document.getElementById('prop-cancion').value,
        artista: document.getElementById('prop-artista').value,
        versos: document.getElementById('prop-versos').value,
        dificultad: document.getElementById('prop-dificultad').value,
        siguienteVerso: document.getElementById('prop-siguiente-verso').value
    };
    if (propuesta.versos.trim()) {
        socket.emit('enviarPropuesta', { idSala: miSalaId, propuesta });
        document.getElementById('btn-enviar-propuesta').disabled = true;
        document.getElementById('esperando-propuestas').style.display = 'block';
    } else {
        alert("Por favor, introduce los versos de tu reto.");
    }
});

socket.on('propuestaRecibida', (idJugador) => { console.log(`Jugador ${idJugador} ha propuesto.`); });

socket.on('empezarFaseAdivinanza', () => {
    socket.emit('distribuirRetos', miSalaId);
});

socket.on('recibirReto', (reto) => {
    tipoRondaActual = reto.tipo;
    document.getElementById('dificultad-reto').innerText = `Dificultad: ${reto.dificultad || 'Media'}`;
    
    const versosBlock = document.getElementById('versos-para-adivinar');
    const caratulaImg = document.getElementById('caratula-album');
    const camposNormal = document.getElementById('campos-ronda-normal');
    const camposAlbum = document.getElementById('campos-ronda-album');
    const camposExtraCompleto = document.getElementById('campos-extra-artista-completo');
    const campoAdivinarVerso = document.getElementById('campo-adivinar-verso');

    versosBlock.style.display = 'none';
    caratulaImg.style.display = 'none';
    camposNormal.style.display = 'none';
    camposAlbum.style.display = 'none';
    camposExtraCompleto.style.display = 'none';
    campoAdivinarVerso.style.display = 'none';
    document.querySelectorAll('#seccion-adivinar input').forEach(input => input.value = '');

    if (reto.tipo === 'RONDA_ALBUM') {
        caratulaImg.src = reto.caratulaUrl;
        caratulaImg.style.display = 'block';
        camposAlbum.style.display = 'block';
    } else {
        versosBlock.innerText = reto.versos || '';
        versosBlock.style.display = 'block';
        camposNormal.style.display = 'block';
        if (reto.tipo === 'ARTISTA_COMPLETO') {
            camposExtraCompleto.style.display = 'block';
        }
        if (reto.tipo === 'CONTINUACION') {
            campoAdivinarVerso.style.display = 'block';
        }
    }
    
    document.getElementById('btn-enviar-respuesta').disabled = false;
    mostrarPantalla('adivinar');
});

document.getElementById('btn-enviar-respuesta').addEventListener('click', () => {
    let respuesta;
    if (tipoRondaActual === 'RONDA_ALBUM') {
        respuesta = {
            album: document.getElementById('adv-album-ra').value,
            artista: document.getElementById('adv-artista-ra').value,
            cancion: document.getElementById('adv-cancion-ra').value,
            ano: document.getElementById('adv-ano-ra').value
        };
    } else {
        respuesta = {
            cancion: document.getElementById('adv-cancion').value,
            artista: document.getElementById('adv-artista').value,
            album: document.getElementById('adv-album').value,
            ano: document.getElementById('adv-ano').value,
            siguienteVerso: document.getElementById('adv-siguiente-verso').value
        };
    }
    socket.emit('enviarRespuesta', { idSala: miSalaId, respuesta });
    document.getElementById('btn-enviar-respuesta').disabled = true;
});

socket.on('finalDeRonda', ({ resultadosRonda, puntuacionesGenerales, esRondaFinal }) => {
    const resumenDiv = document.getElementById('resumen-ronda');
    let todoElHtmlDeResultados = '';

    resultadosRonda.forEach(res => {
        let resultadoHTML = `<div class="tarjeta-resultado"><h4>${res.nombreAdivinador}</h4><p>Reto de: <b>${res.propuestaDe}</b></p><hr style="margin: 15px 0; border-color: #444;">`;
        
        if (res.tipoRonda === 'RONDA_ALBUM') {
            resultadoHTML += `<h5>Reto: Álbum "${res.albumOriginal}"</h5><p>${res.aciertos.album ? '✅' : '❌'} Nombre del Álbum</p><p>${res.aciertos.artista ? '✅' : '❌'} Artista</p><p>${res.aciertos.cancionDeAlbum ? '✅' : '❌'} Canción del Álbum</p><p>${res.aciertos.ano ? '✅' : '❌'} Año</p>`;
        } else if (res.tipoRonda === 'CONTINUACION') {
            const iconoCancion = res.aciertos.cancion ? '✅' : '❌';
            const iconoArtista = res.aciertos.artista ? '✅' : '❌';
            const iconoVerso = res.aciertos.siguienteVerso ? '✅' : '❌';
            resultadoHTML += `<p>${iconoCancion} Canción: <i>${res.cancionOriginal}</i></p><p>${iconoArtista} Artista(s)</p><p>${iconoVerso} Siguiente Verso (Era: "${res.siguienteVersoOriginal}")</p>`;
        } else {
            const iconoCancion = res.aciertos.cancion ? '✅' : '❌';
            const iconoArtista = res.aciertos.artista ? '✅' : '❌';
            resultadoHTML += `<p>${iconoCancion} Canción: <i>${res.cancionOriginal}</i></p><p>${iconoArtista} Artista(s)</p>`;
            if (res.tipoRonda === 'ARTISTA_COMPLETO') {
                const iconoAlbum = res.aciertos.album ? '✅' : '❌';
                const iconoAno = res.aciertos.ano ? '✅' : '❌';
                resultadoHTML += `<p>${iconoAlbum} Álbum (+1 pt)</p><p>${iconoAno} Año (+1 pt)</p>`;
            }
        }
        
        resultadoHTML += `<div class="puntos-ganados">+${res.puntos} Puntos</div>`;
        
        const jugadorAdivinador = puntuacionesGenerales.find(p => p.nombre === res.nombreAdivinador);
        if (jugadorAdivinador && jugadorAdivinador.id === socket.id) {
            resultadoHTML += `<button class="btn-reportar">Reportar Dificultad Incorrecta</button>`;
        }
        resultadoHTML += `</div>`;
        todoElHtmlDeResultados += resultadoHTML;
    });

    resumenDiv.innerHTML = todoElHtmlDeResultados;

    const btnReportar = document.querySelector('.btn-reportar');
    if (btnReportar) {
        btnReportar.addEventListener('click', () => {
            btnReportar.innerText = '¡Reportado!';
            btnReportar.disabled = true;
            socket.emit('reportarJugador', { idSala: miSalaId });
        });
    }

    const puntuacionesUl = document.getElementById('lista-puntuaciones');
    puntuacionesUl.innerHTML = '';
    puntuacionesGenerales.sort((a, b) => b.puntuacion - a.puntuacion).forEach((jugador, index) => {
        const li = document.createElement('li');
        const medalla = index === 0 ? '🥇' : (index === 1 ? '🥈' : (index === 2 ? '🥉' : ''));
        li.innerHTML = `<span>${medalla} ${jugador.nombre} (${jugador.strikes || 0} strikes)</span> <span>${jugador.puntuacion} puntos</span>`;
        puntuacionesUl.appendChild(li);
    });

    const btnSiguiente = document.getElementById('btn-siguiente-ronda');
    const btnVolver = document.getElementById('btn-volver-lobby-resultados');
    if (esRondaFinal) {
        btnSiguiente.style.display = 'none';
        btnVolver.style.display = 'block';
    } else {
        btnSiguiente.style.display = 'block';
        btnVolver.style.display = 'none';
    }
    mostrarPantalla('resultados');
});

socket.on('recibirStrike', (data) => {
    console.log(`¡Has recibido un strike! Total: ${data.strikesActuales}`);
    
    inicializarAudio();
    
    const strikeOverlay = document.getElementById('strike-overlay');
    const splatSound = document.getElementById('splat-sound');
    const body = document.body;

    if (strikeOverlay && splatSound) {
        console.log("¡Activando animación de strike!");

        splatSound.currentTime = 0;
        splatSound.play().catch(e => console.error("Error al reproducir el sonido de strike:", e));

        body.classList.add('screen-shake');
        strikeOverlay.classList.add('visible');

        setTimeout(() => {
            strikeOverlay.classList.remove('visible');
            body.classList.remove('screen-shake');
        }, 5500);
    } else {
        console.error("No se pudo encontrar #strike-overlay o #splat-sound en el DOM.");
    }
});

socket.on('connect', () => { console.log(`Conectado al servidor con ID: ${socket.id}`); });
socket.on('error', (mensaje) => { alert(`Error del servidor: ${mensaje}`); });


chatToggle.addEventListener('click', () => {
    chatContainer.classList.toggle('open');
    if (chatContainer.classList.contains('open')) {
        chatUnreadDot.style.display = 'none';
    }
});

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const mensaje = chatInput.value.trim();
    if (mensaje && miSalaId) {
        socket.emit('enviarMensajeChat', { idSala: miSalaId, mensaje: mensaje });
        chatInput.value = '';
    }
});

socket.on('nuevoMensajeChat', (data) => {
    const { nombre, mensaje } = data;
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message');

    if (nombre === miNombre) {
        messageElement.classList.add('sent');
    } else {
        messageElement.classList.add('received');
        const senderElement = document.createElement('div');
        senderElement.classList.add('sender');
        senderElement.innerText = nombre;
        messageElement.appendChild(senderElement);
    }
    
    const textElement = document.createElement('span');
    textElement.innerText = mensaje;
    messageElement.appendChild(textElement);

    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!chatContainer.classList.contains('open')) {
        chatUnreadDot.style.display = 'block';
    }
});

// Script para el efecto de resplandor del cursor
document.body.addEventListener('mousemove', (e) => {
    // Actualizamos las variables CSS '--x' e '--y' con la posición del ratón
    document.documentElement.style.setProperty('--x', e.clientX + 'px');
    document.documentElement.style.setProperty('--y', e.clientY + 'px');
});