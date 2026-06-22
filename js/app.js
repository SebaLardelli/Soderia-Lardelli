(function(){
  "use strict";

  /* ===================== estado ===================== */
  var productos = [];           // {id, nombre, precio, codigo, categoriaId}
  var categorias = [];          // {id, nombre}
  var categoriaFiltro = '';     // '' = todas
  var contadorBoleta = 1;
  var cantidades = {};          // productoId -> cantidad elegida en la boleta actual
  var itemsManuales = [];       // [{id, nombre, precio, cantidad}]
  var editandoId = null;
  var editandoCategoriaId = null;
  var historial = [];           // [{id, numero, fecha, cliente, lineas, subtotal, descuentoMonto, total, negocio, guardadoEn}]
  var clientes = [];            // {id, nombre}
  var editandoClienteId = null;
  var boletaCompartidaWpp = false;
  var boletaImpresa = false;
  var supabaseClient = null;
  var nubeTimeout = null;
  var guardandoEnNube = false;
  var aplicandoRemoto = false;
  var nubeActiva = false;

  var fmt = new Intl.NumberFormat('es-AR', {minimumFractionDigits:0, maximumFractionDigits:0});
  function money(n){ return '$ ' + fmt.format(isFinite(n) ? n : 0); }
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function numeroProductoDesdeValor(valor){
    var n = parseInt(String(valor || '').trim(), 10);
    return isNaN(n) ? null : n;
  }

  function maxNumeroProductoExistente(){
    var max = 0;
    productos.forEach(function(p){
      var nId = numeroProductoDesdeValor(p.id);
      if (nId !== null && nId > max) max = nId;
      var nCod = numeroProductoDesdeValor(p.codigo);
      if (nCod !== null && nCod > max) max = nCod;
    });
    return max;
  }

  function nuevoIdProducto(){
    return String(maxNumeroProductoExistente() + 1);
  }

  function actualizarCampoCodigoProducto(){
    var el = document.getElementById('p-codigo');
    if (!el || editandoId) return;
    el.readOnly = true;
    el.value = nuevoIdProducto();
  }

  function actualizarNumeroBoleta(){
    var el = document.getElementById('b-numero');
    if (el) el.value = String(contadorBoleta).padStart(4, '0');
  }

  function sincronizarContadorBoleta(){
    var max = 0;
    historial.forEach(function(h){
      var n = parseInt(String(h.numero || '').replace(/\D/g, ''), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    if (max >= contadorBoleta) contadorBoleta = max + 1;
  }

  function hayBoletaPendiente(){
    return calcularBoleta().lineas.length > 0;
  }

  function ofrecerGuardarBoletaPendiente(mensaje){
    if (!hayBoletaPendiente()) return true;
    if (confirm(mensaje || 'Tenés productos en la boleta sin guardar en el historial. ¿Querés guardarla ahora?')){
      return guardarBoletaEnHistorialInterno();
    }
    return true;
  }

  function confirmarDescartarBoletaPendiente(mensaje){
    if (!hayBoletaPendiente()) return true;
    return confirm(mensaje || '¿Continuar sin guardar? Se perderá la boleta actual.');
  }

  function resolverBoletaPendienteAntesDeReemplazar(mensajeGuardar, mensajeDescartar){
    if (!ofrecerGuardarBoletaPendiente(mensajeGuardar)) return false;
    if (hayBoletaPendiente() && !confirmarDescartarBoletaPendiente(mensajeDescartar)) return false;
    return true;
  }

  var historialDetalleAbiertoId = null;
  var pinResolver = null;

  window.validarClienteBoleta = function(mostrarError){
    var el = document.getElementById('b-cliente');
    var errorEl = document.getElementById('b-cliente-error');
    if (!el) return false;

    var nombre = normalizarNombreCliente(el.value);

    function setHint(tipo, texto){
      if (!errorEl) return;
      errorEl.className = 'field-hint' + (tipo ? ' ' + tipo : '');
      errorEl.textContent = texto || '';
    }

    if (!nombre){
      el.classList.remove('field-ok');
      if (mostrarError !== false){
        el.classList.add('field-invalid');
        setHint('error', 'Ingresá el nombre del cliente.');
        el.focus();
      } else {
        el.classList.remove('field-invalid');
        setHint('', '');
      }
      return false;
    }

    if (nombre.length < 2){
      el.classList.remove('field-ok');
      if (mostrarError !== false){
        el.classList.add('field-invalid');
        setHint('error', 'El nombre debe tener al menos 2 caracteres.');
        el.focus();
      }
      return false;
    }

    el.classList.remove('field-invalid');
    var existente = clientePorNombre(nombre);

    if (existente){
      el.classList.add('field-ok');
      setHint('ok', 'Cliente registrado.');
      return true;
    }

    el.classList.remove('field-ok');
    var similares = buscarClientesSimilares(nombre).filter(function(c){
      return c.nombre.toLowerCase() !== nombre.toLowerCase();
    });
    if (similares.length > 0){
      setHint('info', 'Cliente nuevo. ¿Quisiste decir «' + similares[0].nombre + '»?');
    } else {
      setHint('info', 'Cliente nuevo — se agregará a tu lista al guardar la boleta.');
    }
    return true;
  };

  window.normalizarClienteBoleta = function(){
    var el = document.getElementById('b-cliente');
    if (!el) return;
    var nombre = normalizarNombreCliente(el.value);
    if (!nombre){
      validarClienteBoleta(false);
      return;
    }
    var existente = clientePorNombre(nombre);
    if (existente) el.value = existente.nombre;
    else el.value = nombre;
    validarClienteBoleta(false);
  };

  function resolverClienteBoleta(registrarSiNuevo){
    if (!validarClienteBoleta(true)) return null;
    var el = document.getElementById('b-cliente');
    var nombre = normalizarNombreCliente(el.value);
    var existente = clientePorNombre(nombre);
    if (existente){
      el.value = existente.nombre;
      validarClienteBoleta(false);
      return existente.nombre;
    }
    if (registrarSiNuevo){
      var nuevo = registrarClienteDesdeBoleta(nombre);
      if (nuevo){
        el.value = nuevo.nombre;
        validarClienteBoleta(false);
        return nuevo.nombre;
      }
    }
    return nombre;
  }

  function validarBoletaParaAccion(){
    if (!resolverClienteBoleta(true)) return false;
    var calc = calcularBoleta();
    if (calc.lineas.length === 0){
      mostrarAviso('Agregá al menos un producto');
      return false;
    }
    return true;
  }

  function resetearFlagsBoletaSesion(){
    boletaCompartidaWpp = false;
    boletaImpresa = false;
  }

  function limpiarBoletaActual(){
    cantidades = {};
    itemsManuales = [];
    resetearFlagsBoletaSesion();
    document.getElementById('b-descuento').value = 0;
    document.getElementById('b-cliente').value = '';
    document.getElementById('b-cliente').classList.remove('field-invalid', 'field-ok');
    document.getElementById('b-cliente-error').className = 'field-hint';
    document.getElementById('b-cliente-error').textContent = '';
    document.getElementById('b-fecha').value = hoyISO();
    var pagadaEl = document.getElementById('b-pagada');
    if (pagadaEl) pagadaEl.checked = false;
    renderListaBoleta();
    renderResumenBoleta();
}

  /* ===================== nube (Supabase) — datos compartidos en familia ===================== */
  function getConfig(){
    return window.SODERIA_CONFIG || {};
  }

  function configDisponible(){
    var c = getConfig();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  }

  function mostrarErrorConfigFaltante(){
    var gate = document.getElementById('pin-gate');
    var input = document.getElementById('pin-input');
    var btn = document.getElementById('pin-btn');
    var hint = gate ? gate.querySelector('.pin-card p') : null;
    if (hint){
      hint.textContent = 'Falta la configuración en GitHub Pages. En el repo: Settings → Pages → Source debe ser «GitHub Actions» (no «Deploy from a branch»). Cargá los Secrets (SUPABASE_URL, SUPABASE_ANON_KEY, FAMILY_PIN) y ejecutá el workflow «Deploy GitHub Pages». En tu PC: creá config.js local.';
    }
    if (input) input.style.display = 'none';
    if (btn) btn.style.display = 'none';
    if (gate){
      gate.classList.add('show');
      gate.setAttribute('aria-hidden', 'false');
    }
  }

  function supabaseConfigurado(){
    var c = getConfig();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
      c.SUPABASE_URL.indexOf('TU-PROYECTO') === -1 &&
      c.SUPABASE_ANON_KEY.indexOf('TU-ANON') === -1);
  }

  function initSupabase(){
    if (supabaseClient) return true;
    if (!supabaseConfigurado() || typeof supabase === 'undefined') return false;
    supabaseClient = supabase.createClient(getConfig().SUPABASE_URL, getConfig().SUPABASE_ANON_KEY);
    return true;
  }

  function datosAPayload(){
    return {
      productos: productos,
      categorias: categorias,
      contadorBoleta: contadorBoleta,
      negocio: document.getElementById('b-negocio') ? (document.getElementById('b-negocio').value || '') : '',
      historial: historial,
      clientes: clientes
    };
  }

  function payloadTieneDatos(d){
    return d && Array.isArray(d.productos) && d.productos.length > 0;
  }

  function normalizarBoletaHistorial(h){
    if (!h || typeof h !== 'object') return h;
    if (h.pagada === undefined) h.pagada = false;
    h.archivada = !!h.pagada;
    if (h.recordatorioSemana === undefined) h.recordatorioSemana = 0;
    return h;
  }

  function aplicarPayload(datos){
    if (!datos) return;
    productos = datos.productos || [];
    categorias = Array.isArray(datos.categorias) ? datos.categorias : [];
    contadorBoleta = datos.contadorBoleta || 1;
    historial = Array.isArray(datos.historial) ? datos.historial.map(normalizarBoletaHistorial) : [];
    clientes = Array.isArray(datos.clientes) ? datos.clientes : [];
    sincronizarContadorBoleta();
    if (document.getElementById('b-negocio')){
      document.getElementById('b-negocio').value = datos.negocio || 'Soderia Lardelli';
    }
  }

  function persistirLocalStorageSilencioso(){
    try{
      localStorage.setItem('gb_productos', JSON.stringify(productos));
      localStorage.setItem('gb_categorias', JSON.stringify(categorias));
      localStorage.setItem('gb_contador', String(contadorBoleta));
      localStorage.setItem('gb_historial', JSON.stringify(historial));
      localStorage.setItem('gb_clientes', JSON.stringify(clientes));
      if (document.getElementById('b-negocio')){
        localStorage.setItem('gb_negocio', document.getElementById('b-negocio').value);
      }
    }catch(e){ console.warn('No se pudo guardar en localStorage', e); }
  }

  function actualizarEstadoNube(conectada){
    var el = document.getElementById('stat-nube');
    if (!el) return;
    nubeActiva = !!conectada && supabaseConfigurado();
    if (!supabaseConfigurado()){
      el.textContent = 'solo este dispositivo';
      el.className = 'sync-off';
    } else if (nubeActiva){
      el.textContent = 'conectada ✓';
      el.className = 'sync-ok';
    } else {
      el.textContent = 'sin conexión';
      el.className = 'sync-warn';
    }
  }

  function refrescarTodaLaUI(){
    renderCategorias();
    renderSelectCategoriaProducto();
    renderProductos();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    renderResumenBoleta();
    actualizarStatHistorial();
    renderClientes();
}

  async function leerDesdeNube(){
    if (!supabaseClient) return null;
    var res = await supabaseClient.from('app_datos').select('payload, updated_at').eq('id', 'main').maybeSingle();
    if (res.error){
      console.warn('Error leyendo nube', res.error);
      return null;
    }
    return res.data;
  }

  async function guardarEnNube(silencioso){
    if (!supabaseClient || guardandoEnNube) return false;
    guardandoEnNube = true;
    var res = await supabaseClient.from('app_datos').upsert({
      id: 'main',
      payload: datosAPayload(),
      updated_at: new Date().toISOString()
    });
    guardandoEnNube = false;
    if (res.error){
      console.warn('Error guardando en nube', res.error);
      actualizarEstadoNube(false);
      if (!silencioso) mostrarAviso('No se pudo guardar en la nube');
      return false;
    }
    actualizarEstadoNube(true);
    var stat = document.getElementById('stat-guardado');
    if (stat){
      stat.textContent = new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    }
    return true;
  }

  function programarGuardadoNube(){
    if (!supabaseClient) return;
    clearTimeout(nubeTimeout);
    nubeTimeout = setTimeout(function(){ guardarEnNube(true); }, 900);
  }

  function suscribirCambiosNube(){
    if (!supabaseClient || supabaseClient._soderiaCanal) return;
    supabaseClient._soderiaCanal = supabaseClient
      .channel('soderia-datos')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'app_datos', filter: 'id=eq.main'
      }, function(evt){
        if (guardandoEnNube || aplicandoRemoto) return;
        if (evt.new && evt.new.payload){
          aplicandoRemoto = true;
          aplicarPayload(evt.new.payload);
          persistirLocalStorageSilencioso();
          refrescarTodaLaUI();
          mostrarAviso('Actualizado desde otro dispositivo 🔄');
          aplicandoRemoto = false;
        }
      })
      .subscribe();
  }

  function asegurarAccesoFamilia(){
    var pinCfg = (getConfig().FAMILY_PIN || '').trim();
    if (!pinCfg) return Promise.resolve(true);
    if (sessionStorage.getItem('soderia_pin_ok') === '1') return Promise.resolve(true);

    return new Promise(function(resolve){
      var gate = document.getElementById('pin-gate');
      var input = document.getElementById('pin-input');
      var btn = document.getElementById('pin-btn');
      if (!gate || !input || !btn){ resolve(true); return; }

      gate.classList.add('show');
      gate.setAttribute('aria-hidden', 'false');
      input.value = '';
      input.focus();

      pinResolver = resolve;
    });
  }

  /* ===================== arranque / carga de datos ===================== */
  async function cargarDatosLocales(){
    var datos = {productos:[], categorias:[], contadorBoleta:1, negocio:'Soderia Lardelli', historial:[], clientes:[]};

    try{
      var ls = localStorage.getItem('gb_productos');
      if (ls){ datos.productos = JSON.parse(ls); }
      var lsC = localStorage.getItem('gb_contador');
      if (lsC){ datos.contadorBoleta = parseInt(lsC, 10) || 1; }
      var lsN = localStorage.getItem('gb_negocio');
      if (lsN){ datos.negocio = lsN; }
      var lsCat = localStorage.getItem('gb_categorias');
      if (lsCat){ datos.categorias = JSON.parse(lsCat); }
      var lsH = localStorage.getItem('gb_historial');
      if (lsH){ datos.historial = JSON.parse(lsH); }
      var lsCl = localStorage.getItem('gb_clientes');
      if (lsCl){ datos.clientes = JSON.parse(lsCl); }
    }catch(e){ console.warn('No se pudo leer localStorage', e); }

    if (!payloadTieneDatos(datos)){
      try{
        var res = await fetch('data/seed.json');
        if (res.ok){
          var seed = await res.json();
          if (payloadTieneDatos(seed)) datos = seed;
        }
      }catch(e){ console.warn('No se pudo cargar seed.json', e); }
    }

    return datos;
  }

  async function cargarDatos(){
    aplicarPayload(await cargarDatosLocales());
    persistirLocalStorageSilencioso();

    if (!initSupabase()){
      actualizarEstadoNube(false);
      return;
    }

    var remoto = await leerDesdeNube();
    if (remoto && payloadTieneDatos(remoto.payload)){
      aplicarPayload(remoto.payload);
      persistirLocalStorageSilencioso();
    } else if (payloadTieneDatos(datosAPayload())){
      await guardarEnNube(true);
    }

    suscribirCambiosNube();
    actualizarEstadoNube(true);
  }

  function persistirLocalStorage(){
    persistirLocalStorageSilencioso();
    programarGuardadoNube();
  }

  function guardarNegocio(){
    try{ localStorage.setItem('gb_negocio', document.getElementById('b-negocio').value); }catch(e){}
    programarGuardadoNube();
  }
  window.guardarNegocio = guardarNegocio;

  /* ===================== tabs ===================== */
  window.cambiarTab = function(tab){
    var panelBoleta = document.getElementById('panel-boleta');
    if (panelBoleta && panelBoleta.classList.contains('active') && tab !== 'boleta'){
      if (!ofrecerGuardarBoletaPendiente('Tenés una boleta sin guardar. ¿Querés guardarla en el historial antes de cambiar de pestaña?')) return;
    }
    var paneles = ['productos', 'boleta', 'historial'];
    paneles.forEach(function(p){
      var activo = p === tab;
      document.getElementById('panel-' + p).classList.toggle('active', activo);
      document.getElementById('tab-btn-' + p).setAttribute('aria-selected', String(activo));
    });
    if (tab === 'boleta'){ renderListaBoleta(); renderResumenBoleta(); }
    if (tab === 'historial'){ renderHistorial(); }
  };

  /* ===================== categorías: alta / edición / baja ===================== */
  function categoriaPorId(id){
    return categorias.find(function(c){ return c.id === id; });
  }

  window.guardarCategoria = function(ev){
    if (ev) ev.preventDefault();
    var nombre = document.getElementById('c-nombre').value.trim();
    var errorEl = document.getElementById('c-error');
    errorEl.textContent = '';

    if (!nombre){ errorEl.textContent = 'Poné un nombre para la categoría.'; return false; }

    var dup = categorias.find(function(c){
      return c.nombre.toLowerCase() === nombre.toLowerCase() && c.id !== editandoCategoriaId;
    });
    if (dup){ errorEl.textContent = 'Ya existe una categoría con ese nombre.'; return false; }

    if (editandoCategoriaId){
      var existente = categoriaPorId(editandoCategoriaId);
      if (existente){ existente.nombre = nombre; }
      cancelarEdicionCategoria();
      mostrarAviso('Categoría actualizada ✅');
    } else {
      categorias.push({ id: uid(), nombre: nombre });
      mostrarAviso('Categoría agregada ✅');
    }

    document.getElementById('form-categoria').reset();
    persistirLocalStorage();
    renderCategorias();
    renderProductos();
    renderSelectCategoriaProducto();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    return false;
  };

  window.editarCategoria = function(id){
    var c = categoriaPorId(id);
    if (!c) return;
    editandoCategoriaId = id;
    document.getElementById('c-nombre').value = c.nombre;
    document.getElementById('cat-editing-banner').style.display = 'flex';
    document.getElementById('c-submit-btn').textContent = 'Guardar cambios';
    document.getElementById('c-nombre').focus();
  };

  window.cancelarEdicionCategoria = function(){
    editandoCategoriaId = null;
    document.getElementById('form-categoria').reset();
    document.getElementById('cat-editing-banner').style.display = 'none';
    document.getElementById('c-submit-btn').textContent = '＋ Agregar categoría';
    document.getElementById('c-error').textContent = '';
  };

  window.eliminarCategoria = function(id){
    var c = categoriaPorId(id);
    if (!c) return;
    var enUso = productos.filter(function(p){ return p.categoriaId === id; }).length;
    var aviso = '¿Eliminar la categoría "' + c.nombre + '"?';
    if (enUso > 0){ aviso += ' ' + enUso + ' producto(s) quedarán sin categoría.'; }
    if (!confirm(aviso)) return;

    categorias = categorias.filter(function(x){ return x.id !== id; });
    productos.forEach(function(p){
      if (p.categoriaId === id){ p.categoriaId = ''; }
    });
    if (categoriaFiltro === id){ categoriaFiltro = ''; }
    if (editandoCategoriaId === id) cancelarEdicionCategoria();

    persistirLocalStorage();
    renderCategorias();
    renderProductos();
    renderSelectCategoriaProducto();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    mostrarAviso('Categoría eliminada');
  };

  function renderCategorias(){
    var wrap = document.getElementById('lista-categorias-wrap');
    wrap.className = 'scroll-panel lista-side-scroll';
    document.getElementById('categorias-count').textContent = '(' + categorias.length + ')';

    if (categorias.length === 0){
      wrap.innerHTML = '<div class="empty-state" style="padding:18px 6px;">Todavía no creaste categorías.<br>Agregá la primera arriba (ej: Vinos, Sodas, Aguas).</div>';
      return;
    }

    wrap.innerHTML = '<div class="cat-lista">' + categorias.map(function(c){
      var cant = productos.filter(function(p){ return p.categoriaId === c.id; }).length;
      return '<div class="cat-item">' +
        '<span class="nombre">' + escapeHtml(c.nombre) + '</span>' +
        '<span class="cant">' + cant + (cant === 1 ? ' prod.' : ' prods.') + '</span>' +
        '<span class="acciones">' +
          '<button type="button" class="btn-icon" title="Editar" data-action="editar-categoria" data-id="' + escapeHtml(c.id) + '">✏️</button>' +
          '<button type="button" class="btn-icon danger" title="Eliminar" data-action="eliminar-categoria" data-id="' + escapeHtml(c.id) + '">🗑️</button>' +
        '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderSelectCategoriaProducto(){
    var sel = document.getElementById('p-categoria');
    var valorActual = sel.value;
    sel.innerHTML = '<option value="">Sin categoría</option>' + categorias.map(function(c){
      return '<option value="' + c.id + '">' + escapeHtml(c.nombre) + '</option>';
    }).join('');
    if (categoriaPorId(valorActual)){ sel.value = valorActual; }
  }

  /* ===================== clientes: alta / edición / baja ===================== */
  function normalizarNombreCliente(nombre){
    return String(nombre || '').trim().replace(/\s+/g, ' ');
  }

  function clientePorId(id){
    return clientes.find(function(c){ return c.id === id; });
  }

  function clientePorNombre(nombre){
    var n = normalizarNombreCliente(nombre).toLowerCase();
    if (!n) return null;
    return clientes.find(function(c){ return c.nombre.toLowerCase() === n; }) || null;
  }

  function buscarClientesSimilares(nombre){
    var n = normalizarNombreCliente(nombre).toLowerCase();
    if (n.length < 2) return [];
    return clientes.filter(function(c){
      var cn = c.nombre.toLowerCase();
      return cn.indexOf(n) !== -1 || n.indexOf(cn) !== -1;
    }).sort(function(a, b){
      var aExact = a.nombre.toLowerCase().indexOf(n) === 0 ? 0 : 1;
      var bExact = b.nombre.toLowerCase().indexOf(n) === 0 ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.nombre.localeCompare(b.nombre, 'es');
    }).slice(0, 3);
  }

  function registrarClienteDesdeBoleta(nombre){
    nombre = normalizarNombreCliente(nombre);
    if (!nombre || nombre.length < 2) return null;
    var existente = clientePorNombre(nombre);
    if (existente) return existente;

    var dup = clientes.find(function(c){
      return c.nombre.toLowerCase() === nombre.toLowerCase();
    });
    if (dup) return dup;

    var nuevo = { id: uid(), nombre: nombre };
    clientes.push(nuevo);
    persistirLocalStorage();
    renderClientes();
return nuevo;
  }

  window.guardarCliente = function(ev){
    if (ev) ev.preventDefault();
    var nombre = normalizarNombreCliente(document.getElementById('cl-nombre').value);
    var errorEl = document.getElementById('cl-error');
    errorEl.textContent = '';

    if (!nombre){ errorEl.textContent = 'Poné un nombre para el cliente.'; return false; }

    var dup = clientes.find(function(c){
      return c.nombre.toLowerCase() === nombre.toLowerCase() && c.id !== editandoClienteId;
    });
    if (dup){ errorEl.textContent = 'Ya existe un cliente con ese nombre.'; return false; }

    if (editandoClienteId){
      var existente = clientePorId(editandoClienteId);
      if (existente){ existente.nombre = nombre; }
      cancelarEdicionCliente();
      mostrarAviso('Cliente actualizado ✅');
    } else {
      clientes.push({ id: uid(), nombre: nombre });
      mostrarAviso('Cliente agregado ✅');
    }

    document.getElementById('form-cliente').reset();
    persistirLocalStorage();
    renderClientes();
    return false;
  };

  window.editarCliente = function(id){
    var c = clientePorId(id);
    if (!c) return;
    editandoClienteId = id;
    document.getElementById('cl-nombre').value = c.nombre;
    document.getElementById('cli-editing-banner').style.display = 'flex';
    document.getElementById('cl-submit-btn').textContent = 'Guardar cambios';
    document.getElementById('cl-nombre').focus();
  };

  window.cancelarEdicionCliente = function(){
    editandoClienteId = null;
    document.getElementById('form-cliente').reset();
    document.getElementById('cli-editing-banner').style.display = 'none';
    document.getElementById('cl-submit-btn').textContent = '＋ Agregar cliente';
    document.getElementById('cl-error').textContent = '';
  };

  window.eliminarCliente = function(id){
    var c = clientePorId(id);
    if (!c) return;
    if (!confirm('¿Eliminar al cliente "' + c.nombre + '"? (Esto no borra boletas ya guardadas)')) return;
    clientes = clientes.filter(function(x){ return x.id !== id; });
    if (editandoClienteId === id) cancelarEdicionCliente();
    persistirLocalStorage();
    renderClientes();
    mostrarAviso('Cliente eliminado');
  };

  function renderClientes(){
    var wrap = document.getElementById('lista-clientes-wrap');
    if (wrap) wrap.className = 'scroll-panel lista-side-scroll';
    var countEl = document.getElementById('clientes-count');
    if (countEl) countEl.textContent = '(' + clientes.length + ')';

    if (wrap){
      if (clientes.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:18px 6px;">Todavía no cargaste clientes.<br>Agregá el primero arriba para poder referenciarlo en tus boletas.</div>';
      } else {
        wrap.innerHTML = '<div class="cat-lista">' + clientes.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).map(function(c){
          return '<div class="cat-item">' +
            '<span class="nombre">' + escapeHtml(c.nombre) + '</span>' +
            '<span class="acciones">' +
              '<button type="button" class="btn-icon" title="Editar" data-action="editar-cliente" data-id="' + escapeHtml(c.id) + '">✏️</button>' +
              '<button type="button" class="btn-icon danger" title="Eliminar" data-action="eliminar-cliente" data-id="' + escapeHtml(c.id) + '">🗑️</button>' +
            '</span>' +
          '</div>';
        }).join('') + '</div>';
      }
    }
    renderClientesDatalist();
  }

  function renderClientesDatalist(){
    var dl = document.getElementById('clientes-datalist');
    if (!dl) return;
    dl.innerHTML = clientes.map(function(c){
      return '<option value="' + escapeHtml(c.nombre) + '"></option>';
    }).join('');
  }


  window.guardarProducto = function(ev){
    ev.preventDefault();
    var nombre = document.getElementById('p-nombre').value.trim();
    var precio = parseFloat(document.getElementById('p-precio').value);
    var categoriaId = document.getElementById('p-categoria').value;
    var errorEl = document.getElementById('p-error');
    errorEl.textContent = '';

    if (!nombre){ errorEl.textContent = 'Poné un nombre para el producto.'; return false; }
    if (isNaN(precio) || precio < 0){ errorEl.textContent = 'El precio tiene que ser un número mayor o igual a 0.'; return false; }

    if (editandoId){
      var existente = productos.find(function(p){ return p.id === editandoId; });
      if (existente){
        var codigo = document.getElementById('p-codigo').value.trim();
        existente.nombre = nombre; existente.precio = precio; existente.codigo = codigo; existente.categoriaId = categoriaId;
      }
      cancelarEdicion();
      mostrarAviso('Producto actualizado ✅');
    } else {
      var nuevoId = nuevoIdProducto();
      productos.push({ id: nuevoId, nombre: nombre, precio: precio, codigo: nuevoId, categoriaId: categoriaId });
      mostrarAviso('Producto agregado ✅ · N° ' + nuevoId);
    }

    document.getElementById('form-producto').reset();
    actualizarCampoCodigoProducto();
    persistirLocalStorage();
    renderProductos();
    renderCategorias();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    return false;
  };

  window.editarProducto = function(id){
    var p = productos.find(function(x){ return x.id === id; });
    if (!p) return;
    editandoId = id;
    document.getElementById('p-nombre').value = p.nombre;
    document.getElementById('p-precio').value = p.precio;
    document.getElementById('p-codigo').readOnly = false;
    document.getElementById('p-codigo').value = p.codigo || '';
    document.getElementById('p-categoria').value = p.categoriaId || '';
    document.getElementById('form-titulo').textContent = 'Editar producto';
    document.getElementById('p-submit-btn').textContent = 'Guardar cambios';
    document.getElementById('editing-banner').style.display = 'flex';
    document.getElementById('p-nombre').focus();
  };

  window.cancelarEdicion = function(){
    editandoId = null;
    document.getElementById('form-producto').reset();
    document.getElementById('form-titulo').textContent = 'Agregar producto';
    document.getElementById('p-submit-btn').textContent = 'Agregar producto';
    document.getElementById('editing-banner').style.display = 'none';
    document.getElementById('p-error').textContent = '';
    actualizarCampoCodigoProducto();
  };

  window.eliminarProducto = function(id){
    var p = productos.find(function(x){ return x.id === id; });
    if (!p) return;
    if (!confirm('¿Eliminar "' + p.nombre + '" del catálogo?')) return;
    productos = productos.filter(function(x){ return x.id !== id; });
    delete cantidades[id];
    if (editandoId === id) cancelarEdicion();
    else actualizarCampoCodigoProducto();
    persistirLocalStorage();
    renderProductos();
    renderCategorias();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    renderResumenBoleta();
    mostrarAviso('Producto eliminado');
  };

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function renderProductos(){
    var wrap = document.getElementById('tabla-productos-wrap');
    var buscador = document.getElementById('buscador-catalogo');
    var query = (buscador && buscador.value || '').toLowerCase().trim();
    document.getElementById('stat-productos').textContent = productos.length;
    document.getElementById('catalogo-count').textContent = '(' + productos.length + ')';

    var meta = document.getElementById('catalogo-meta');
    if (meta){
      if (query){
        meta.innerHTML = 'Mostrando <b id="catalogo-filtrados">' + productos.filter(function(p){
          return p.nombre.toLowerCase().indexOf(query) !== -1 || (p.codigo || '').toLowerCase().indexOf(query) !== -1;
        }).length + '</b> de <b>' + productos.length + '</b>';
      } else {
        meta.innerHTML = '<span>' + productos.length + ' productos · deslizá para ver todos</span>';
      }
    }

    if (productos.length === 0){
      wrap.innerHTML = '<div class="empty-state"><span class="big">🗃️</span>Todavía no cargaste productos.<br>Agregá el primero desde el formulario.</div>';
      return;
    }

    var filtrados = productos.filter(function(p){
      if (!query) return true;
      return p.nombre.toLowerCase().indexOf(query) !== -1 || (p.codigo || '').toLowerCase().indexOf(query) !== -1;
    });

    if (filtrados.length === 0){
      wrap.innerHTML = '<div class="empty-state">No hay productos que coincidan con «' + escapeHtml(query) + '».</div>';
      return;
    }

    var filas = filtrados.map(function(p){
      var cat = categoriaPorId(p.categoriaId);
      return '<tr>' +
        '<td>' + escapeHtml(p.nombre) + (p.codigo ? '<span class="codigo-chip">' + escapeHtml(p.codigo) + '</span>' : '') + (cat ? '<span class="categoria-chip">' + escapeHtml(cat.nombre) + '</span>' : '') + '</td>' +
        '<td class="precio mono">' + money(p.precio) + '</td>' +
        '<td class="acciones">' +
          '<button type="button" class="btn-icon" title="Editar" data-action="editar-producto" data-id="' + escapeHtml(p.id) + '">✏️</button>' +
          '<button type="button" class="btn-icon danger" title="Eliminar" data-action="eliminar-producto" data-id="' + escapeHtml(p.id) + '">🗑️</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML = '<table><thead><tr><th>Producto</th><th class="precio">Precio</th><th></th></tr></thead><tbody>' + filas + '</tbody></table>';
  }

  /* ===================== boleta: selección de productos ===================== */
  function productoCoincideFiltroBoleta(p, query){
    if (categoriaFiltro === '__sin__' && p.categoriaId && categoriaPorId(p.categoriaId)) return false;
    if (categoriaFiltro && categoriaFiltro !== '__sin__' && p.categoriaId !== categoriaFiltro) return false;
    if (!query) return true;
    return p.nombre.toLowerCase().indexOf(query) !== -1 || (p.codigo || '').toLowerCase().indexOf(query) !== -1;
  }

  function actualizarContadorBoletaSeleccionados(){
    var seleccionadosEl = document.getElementById('boleta-seleccionados');
    if (seleccionadosEl){
      seleccionadosEl.textContent = productos.filter(function(p){ return (cantidades[p.id] || 0) > 0; }).length;
    }
  }

  function cssEscapeId(id){
    if (window.CSS && CSS.escape) return CSS.escape(id);
    return String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function actualizarFilaCantidadBoleta(id){
    var wrap = document.getElementById('lista-boleta-wrap');
    if (!wrap) return false;
    var row = wrap.querySelector('.producto-pick[data-producto-id="' + cssEscapeId(id) + '"]');
    if (!row) return false;
    var cant = cantidades[id] || 0;
    var input = row.querySelector('input[data-producto-id]');
    if (input) input.value = cant;
    row.classList.toggle('seleccionado', cant > 0);
    return true;
  }

  function cambiarCantidad(id, delta){
    if (!id || !productos.some(function(p){ return p.id === id; })) return;
    var actual = cantidades[id] || 0;
    var nueva = Math.max(0, actual + delta);
    if (nueva === 0) delete cantidades[id];
    else cantidades[id] = nueva;
    if (!actualizarFilaCantidadBoleta(id)) renderListaBoleta();
    actualizarContadorBoletaSeleccionados();
    renderResumenBoleta();
  }
  window.cambiarCantidad = cambiarCantidad;

  window.setCantidad = function(id, valor){
    if (!id || !productos.some(function(p){ return p.id === id; })) return;
    var n = parseInt(valor, 10);
    if (isNaN(n) || n < 0) n = 0;
    if (n === 0) delete cantidades[id];
    else cantidades[id] = n;
    if (!actualizarFilaCantidadBoleta(id)) renderListaBoleta();
    actualizarContadorBoletaSeleccionados();
    renderResumenBoleta();
  };

  var stepperBoletaListo = false;

  function bindStepperBoleta(){
    var wrap = document.getElementById('lista-boleta-wrap');
    if (!wrap || stepperBoletaListo) return;
    stepperBoletaListo = true;
    wrap.addEventListener('click', function(ev){
      var btn = ev.target.closest('[data-cant-delta]');
      if (!btn || !wrap.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var row = btn.closest('.producto-pick[data-producto-id]');
      if (!row) return;
      var id = row.getAttribute('data-producto-id');
      var delta = parseInt(btn.getAttribute('data-cant-delta'), 10);
      if (id && !isNaN(delta)) cambiarCantidad(id, delta);
    });
    wrap.addEventListener('change', function(ev){
      var input = ev.target;
      if (!input.matches('input[data-producto-id]')) return;
      var row = input.closest('.producto-pick[data-producto-id]');
      if (!row) return;
      setCantidad(row.getAttribute('data-producto-id'), input.value);
    });
  }

  function renderFiltrosCategoriaBoleta(){
    var wrap = document.getElementById('cat-filtros-wrap');
    if (!wrap) return;

    if (categorias.length === 0){
      wrap.innerHTML = '';
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'flex';

    var sinCategoriaHay = productos.some(function(p){ return !p.categoriaId || !categoriaPorId(p.categoriaId); });

    var botones = '<button type="button" class="cat-filtro-btn' + (categoriaFiltro === '' ? ' activo' : '') + '" data-action="filtro-categoria" data-cat="">Todas</button>';
    botones += categorias.map(function(c){
      return '<button type="button" class="cat-filtro-btn' + (categoriaFiltro === c.id ? ' activo' : '') + '" data-action="filtro-categoria" data-cat="' + escapeHtml(c.id) + '">' + escapeHtml(c.nombre) + '</button>';
    }).join('');
    if (sinCategoriaHay){
      botones += '<button type="button" class="cat-filtro-btn' + (categoriaFiltro === '__sin__' ? ' activo' : '') + '" data-action="filtro-categoria" data-cat="__sin__">Sin categoría</button>';
    }
    wrap.innerHTML = botones;
  }

  window.setFiltroCategoriaBoleta = function(catId){
    categoriaFiltro = catId;
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
  };

  function renderListaBoleta(){
    var wrap = document.getElementById('lista-boleta-wrap');
    if (!wrap) return;
    bindStepperBoleta();
    var scrollTop = wrap.scrollTop;
    var buscadorEl = document.getElementById('buscador');
    var query = (buscadorEl && buscadorEl.value || '').toLowerCase().trim();
    var filtradosEl = document.getElementById('boleta-filtrados');
    actualizarContadorBoletaSeleccionados();

    if (productos.length === 0){
      if (filtradosEl) filtradosEl.textContent = '0';
      wrap.innerHTML = '<div class="empty-state"><span class="big">📭</span>Cargá productos en la pestaña <b>Productos</b> para poder agregarlos acá.</div>';
      return;
    }

    var filtrados = productos.filter(function(p){ return productoCoincideFiltroBoleta(p, query); });
    var idsVisibles = {};
    filtrados.forEach(function(p){ idsVisibles[p.id] = true; });
    productos.forEach(function(p){
      if ((cantidades[p.id] || 0) > 0 && !idsVisibles[p.id]){
        filtrados.push(p);
        idsVisibles[p.id] = true;
      }
    });

    filtrados.sort(function(a, b){
      return a.nombre.localeCompare(b.nombre, 'es');
    });

    if (filtradosEl) filtradosEl.textContent = filtrados.length;

    if (filtrados.length === 0){
      wrap.innerHTML = '<div class="empty-state">No hay productos que coincidan con el filtro actual.<br><span style="font-size:12px;color:var(--muted);">Probá borrar la búsqueda o elegir «Todas» las categorías.</span></div>';
      return;
    }

    var hayFueraFiltro = filtrados.some(function(p){
      return (cantidades[p.id] || 0) > 0 && !productoCoincideFiltroBoleta(p, query);
    });
    var hintHtml = (hayFueraFiltro && (query || categoriaFiltro))
      ? '<div class="boleta-filtro-hint">Los productos ya agregados a la boleta siguen visibles aunque no coincidan con el filtro.</div>'
      : '';

    wrap.innerHTML = hintHtml + filtrados.map(function(p){
      var cant = cantidades[p.id] || 0;
      var fueraFiltro = cant > 0 && !productoCoincideFiltroBoleta(p, query);
      return '<div class="producto-pick' + (cant > 0 ? ' seleccionado' : '') + (fueraFiltro ? ' fuera-filtro' : '') + '" data-producto-id="' + escapeHtml(p.id) + '">' +
        '<div class="info"><div class="nombre">' + escapeHtml(p.nombre) + '</div><div class="precio mono">' + money(p.precio) + '</div></div>' +
        '<div class="stepper">' +
          '<button type="button" data-cant-delta="-1" aria-label="Quitar uno">−</button>' +
          '<input type="number" min="0" step="1" value="' + cant + '" data-producto-id="' + escapeHtml(p.id) + '" aria-label="Cantidad">' +
          '<button type="button" data-cant-delta="1" aria-label="Agregar uno">＋</button>' +
        '</div>' +
      '</div>';
    }).join('');

    wrap.scrollTop = scrollTop;
  }

  /* ===================== boleta: ítems sueltos (no catálogo) ===================== */
  window.quitarManual = function(id){
    itemsManuales = itemsManuales.filter(function(x){ return x.id !== id; });
    renderResumenBoleta();
  };

  /* ===================== boleta: cálculo y render del resumen ===================== */
  function calcularBoleta(){
    var lineas = [];
    var subtotal = 0;

    productos.forEach(function(p){
      var cant = cantidades[p.id] || 0;
      if (cant > 0){
        var sub = cant * p.precio;
        subtotal += sub;
        lineas.push({ id: p.id, nombre: p.nombre, precio: p.precio, cantidad: cant, subtotal: sub, manual: false });
      }
    });

    itemsManuales.forEach(function(it){
      var sub = it.cantidad * it.precio;
      subtotal += sub;
      lineas.push({ id: it.id, nombre: it.nombre, precio: it.precio, cantidad: it.cantidad, subtotal: sub, manual: true });
    });

    var descuentoValor = parseFloat(document.getElementById('b-descuento').value) || 0;
    var tipo = document.getElementById('b-descuento-tipo').value;
    var descuentoMonto = tipo === 'porcentaje' ? subtotal * (descuentoValor / 100) : descuentoValor;
    if (descuentoMonto < 0) descuentoMonto = 0;
    if (descuentoMonto > subtotal) descuentoMonto = subtotal;

    var total = subtotal - descuentoMonto;
    return { lineas: lineas, subtotal: subtotal, descuentoMonto: descuentoMonto, total: total };
  }

  function renderResumenBoleta(){
    var calc = calcularBoleta();
    var cont = document.getElementById('receipt-items');

    if (calc.lineas.length === 0){
      cont.innerHTML = '<div class="receipt-empty">Todavía no agregaste productos a esta boleta.</div>';
    } else {
      cont.innerHTML = calc.lineas.map(function(l){
        var quitarBtn = l.manual
          ? '<button type="button" class="quitar" title="Quitar" data-action="quitar-manual" data-id="' + escapeHtml(l.id) + '">✕</button>'
          : '<button type="button" class="quitar" title="Quitar" data-action="quitar-producto" data-id="' + escapeHtml(l.id) + '" data-cant="' + l.cantidad + '">✕</button>';
        return '<div class="receipt-line">' +
          '<span class="nombre" title="' + escapeHtml(l.nombre) + '">' + escapeHtml(l.nombre) + '</span>' +
          '<span class="cant">' + l.cantidad + '</span>' +
          '<span class="punit">' + fmt.format(l.precio) + '</span>' +
          '<span class="sub">' + fmt.format(l.subtotal) + quitarBtn + '</span>' +
        '</div>';
      }).join('');
    }

    document.getElementById('r-subtotal').textContent = money(calc.subtotal);
    document.getElementById('r-total').textContent = money(calc.total);
    document.getElementById('mobile-total').textContent = money(calc.total);
  }
  window.renderResumenBoleta = renderResumenBoleta;
  window.renderListaBoleta = renderListaBoleta;
  window.renderProductos = renderProductos;

  window.nuevaBoleta = function(){
    if (!resolverBoletaPendienteAntesDeReemplazar(
      '¿Guardar esta boleta en el historial antes de empezar una nueva?',
      '¿Empezar una boleta nueva sin guardar? Se perderá la boleta actual.'
    )) return;
    if (!hayBoletaPendiente()){
      mostrarAviso('Boleta nueva lista 🧾');
      return;
    }
    contadorBoleta += 1;
    actualizarNumeroBoleta();
    limpiarBoletaActual();
    persistirLocalStorage();
    mostrarAviso('Boleta nueva lista 🧾');
  };

  function hoyISO(){
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function construirReceiptEstatico(datos, etiqueta){
    var clienteHtml = datos.cliente ? escapeHtml(datos.cliente) : '<span style="color:var(--muted); font-style:italic;">Sin nombre de cliente</span>';
    var lineasHtml = datos.lineas.length === 0
      ? '<div class="receipt-empty">Todavía no agregaste productos a esta boleta.</div>'
      : datos.lineas.map(function(l){
          return '<div class="receipt-line">' +
            '<span class="nombre" title="' + escapeHtml(l.nombre) + '">' + escapeHtml(l.nombre) + '</span>' +
            '<span class="cant">' + l.cantidad + '</span>' +
            '<span class="punit">' + fmt.format(l.precio) + '</span>' +
            '<span class="sub">' + fmt.format(l.subtotal) + '</span>' +
          '</div>';
        }).join('');

    return '<div class="print-copy">' +
      '<div class="receipt-card">' +
        '<div class="receipt-biz" style="cursor:default;">' + escapeHtml(datos.negocio || 'Boleta') + '</div>' +
        '<div class="receipt-meta">' +
          '<div class="row"><label>N°</label><span class="mono">' + escapeHtml(datos.numero || '—') + '</span></div>' +
          '<div class="row"><label>Fecha</label><span class="mono">' + formatearFechaLegible(datos.fecha) + '</span></div>' +
          '<div class="row"><label>Cliente</label><span class="mono">' + clienteHtml + '</span></div>' +
        '</div>' +
        '<div class="dashed"></div>' +
        '<div class="receipt-cols"><span>Producto</span><span>Cant.</span><span>P.Unit</span><span>Subt.</span></div>' +
        '<div class="receipt-items">' + lineasHtml + '</div>' +
        '<div class="dashed"></div>' +
        '<div class="receipt-totales">' +
          '<div class="row"><span>Subtotal</span><span class="v mono">' + money(datos.subtotal) + '</span></div>' +
          (datos.descuentoMonto > 0 ? '<div class="row"><span>Descuento</span><span class="v mono">-' + money(datos.descuentoMonto) + '</span></div>' : '') +
          '<div class="row total"><span>Total</span><span class="v mono">' + money(datos.total) + '</span></div>' +
        '</div>' +
        '<div class="receipt-footer-note">Gracias por su compra.</div>' +
      '</div>' +
      '<div class="print-copy-label">' + escapeHtml(etiqueta) + '</div>' +
    '</div>';
  }

  window.imprimirBoleta = function(){
    if (!validarBoletaParaAccion()) return;
    var calc = calcularBoleta();
    var datos = {
      negocio: document.getElementById('b-negocio').value || 'Boleta',
      numero: document.getElementById('b-numero').value,
      fecha: document.getElementById('b-fecha').value,
      cliente: document.getElementById('b-cliente').value.trim(),
      lineas: calc.lineas,
      subtotal: calc.subtotal,
      descuentoMonto: calc.descuentoMonto,
      total: calc.total
    };
    var doble = document.getElementById('print-doble');
    doble.innerHTML =
      construirReceiptEstatico(datos, 'Copia comercio') +
      construirReceiptEstatico(datos, 'Copia cliente');
    window.print();
    boletaImpresa = true;
  };

  /* ===================== formateo de texto para WhatsApp ===================== */
  function textoBoletaParaWhatsapp(datos){
    // datos: { negocio, numero, fecha, cliente, lineas, subtotal, descuentoMonto, total }
    var L = [];
    L.push('*' + (datos.negocio || 'Boleta') + '*');
    L.push('Boleta N° ' + datos.numero + ' · ' + formatearFechaLegible(datos.fecha));
    if (datos.cliente){ L.push('Cliente: ' + datos.cliente); }
    L.push('');
    datos.lineas.forEach(function(l){
      L.push('• ' + l.nombre + ' x' + l.cantidad + ' — ' + money(l.subtotal));
    });
    L.push('');
    L.push('Subtotal: ' + money(datos.subtotal));
    if (datos.descuentoMonto > 0){ L.push('Descuento: -' + money(datos.descuentoMonto)); }
    L.push('*Total: ' + money(datos.total) + '*');
    L.push('');
    L.push('Gracias por su compra.');
    return L.join('\n');
  }

  function formatearFechaLegible(iso){
    if (!iso) return '';
    var partes = iso.split('-');
    if (partes.length !== 3) return iso;
    return partes[2] + '/' + partes[1] + '/' + partes[0];
  }

  function abrirWhatsappConTexto(texto){
    var url = 'https://wa.me/?text=' + encodeURIComponent(texto);
    window.open(url, '_blank');
  }

  window.compartirWhatsapp = function(){
    if (!validarBoletaParaAccion()) return;
    var calc = calcularBoleta();
    var datos = {
      negocio: document.getElementById('b-negocio').value || 'Boleta',
      numero: document.getElementById('b-numero').value,
      fecha: document.getElementById('b-fecha').value,
      cliente: document.getElementById('b-cliente').value.trim(),
      lineas: calc.lineas,
      subtotal: calc.subtotal,
      descuentoMonto: calc.descuentoMonto,
      total: calc.total
    };
    abrirWhatsappConTexto(textoBoletaParaWhatsapp(datos));
    boletaCompartidaWpp = true;
  };

  /* ===================== historial de boletas ===================== */
  function guardarBoletaEnHistorialInterno(opciones){
    opciones = opciones || {};
    var nombreIngresado = normalizarNombreCliente(document.getElementById('b-cliente').value);
    var eraNuevo = nombreIngresado.length >= 2 && !clientePorNombre(nombreIngresado);
    if (!validarBoletaParaAccion()) return false;
    var calc = calcularBoleta();
    var cliente = document.getElementById('b-cliente').value.trim();
    var pagadaEl = document.getElementById('b-pagada');
    var pagada = pagadaEl ? pagadaEl.checked : false;
    var registro = {
      id: uid(),
      numero: document.getElementById('b-numero').value,
      fecha: document.getElementById('b-fecha').value,
      cliente: cliente,
      negocio: document.getElementById('b-negocio').value || '',
      lineas: calc.lineas,
      subtotal: calc.subtotal,
      descuentoMonto: calc.descuentoMonto,
      total: calc.total,
      pagada: pagada,
      archivada: pagada,
      guardadoEn: new Date().toISOString()
    };
    if (pagada) registro.pagadaEn = registro.guardadoEn;
    historial.unshift(registro);
    contadorBoleta += 1;
    actualizarNumeroBoleta();
    limpiarBoletaActual();
    persistirLocalStorage();
    actualizarStatHistorial();
    if (!opciones.silencioso){
      if (eraNuevo){
        mostrarAviso('Boleta guardada · «' + cliente + '» agregado a clientes ✅');
      } else if (pagada){
        mostrarAviso('Boleta guardada como pagada y archivada ✅');
      } else {
        mostrarAviso('Boleta guardada · siguiente N° ' + String(contadorBoleta).padStart(4, '0'));
      }
    }
    return true;
  }

  window.guardarEnHistorial = function(){
    guardarBoletaEnHistorialInterno();
  };

  function actualizarStatHistorial(){
    var el = document.getElementById('stat-historial');
    if (el) el.textContent = historial.length;
    var countEl = document.getElementById('historial-count');
    if (countEl){
      var pendientes = historial.filter(function(h){ return !h.pagada; }).length;
      countEl.textContent = '(' + pendientes + ' pendientes)';
    }
  }

  function historialCoincideBusqueda(h, query){
    if (!query) return true;
    var cliente = (h.cliente || '').toLowerCase();
    var numero = (h.numero || '').toLowerCase();
    return cliente.indexOf(query) !== -1 || numero.indexOf(query) !== -1;
  }

  function htmlPagoBoleta(h, inputId){
    var pagada = !!h.pagada;
    var idAttr = inputId ? ' id="' + inputId + '"' : '';
    return '<label class="pago-check" title="' + (pagada ? 'Desmarcar pago' : 'Marcar como pagada') + '">' +
      '<input type="checkbox" data-action="toggle-pago-historial" data-id="' + escapeHtml(h.id) + '"' + idAttr + (pagada ? ' checked' : '') + '>' +
      '<span>' + (pagada ? 'Pagada' : 'Pago pendiente') + '</span>' +
    '</label>';
  }

  function renderHistorialItem(h){
    var clienteHtml = h.cliente ? escapeHtml(h.cliente) : '<span class="anon">Sin nombre de cliente</span>';
    var cantItems = h.lineas.reduce(function(acc, l){ return acc + l.cantidad; }, 0);
    var pagada = !!h.pagada;
    return '<div class="historial-item' + (pagada ? ' archivada' : '') + '">' +
      htmlPagoBoleta(h) +
      '<div class="num-badge">N°' + escapeHtml(h.numero || '—') + '</div>' +
      '<div class="info">' +
        '<div class="cliente">' + clienteHtml + '</div>' +
        '<div class="meta">' +
          '<span>📅 ' + formatearFechaLegible(h.fecha) + '</span>' +
          '<span>🧺 ' + cantItems + (cantItems === 1 ? ' ítem' : ' ítems') + '</span>' +
          '<span class="pago-badge ' + (pagada ? 'pagada' : 'pendiente') + '">' + (pagada ? 'Archivada' : 'Cobro pendiente') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="monto mono">' + money(h.total) + '</div>' +
      '<div class="acciones">' +
        '<button type="button" class="btn-icon" title="Ver boleta" data-action="ver-historial" data-id="' + escapeHtml(h.id) + '">👁️</button>' +
        '<button type="button" class="btn-icon" title="Compartir por WhatsApp" data-action="wpp-historial" data-id="' + escapeHtml(h.id) + '">💬</button>' +
        '<button type="button" class="btn-icon danger" title="Eliminar" data-action="eliminar-historial" data-id="' + escapeHtml(h.id) + '">🗑️</button>' +
      '</div>' +
    '</div>';
  }

  function renderHistorial(){
    var wrap = document.getElementById('historial-lista-wrap');
    var query = (document.getElementById('buscador-historial').value || '').toLowerCase().trim();
    actualizarStatHistorial();

    if (historial.length === 0){
      wrap.innerHTML = '<div class="empty-state"><span class="big">🗂️</span>Todavía no guardaste ninguna boleta.<br>Armá una en la pestaña <b>Boleta</b> y usá «Guardar en historial».</div>';
      return;
    }

    var activas = historial.filter(function(h){ return !h.pagada && historialCoincideBusqueda(h, query); });
    var archivadas = historial.filter(function(h){ return h.pagada && historialCoincideBusqueda(h, query); });

    if (activas.length === 0 && archivadas.length === 0){
      wrap.innerHTML = '<div class="empty-state">No hay boletas que coincidan con «' + escapeHtml(query) + '».</div>';
      return;
    }

    var html = '';
    if (activas.length > 0){
      html += '<div class="historial-seccion-titulo">Pendientes de pago <span class="count">(' + activas.length + ')</span></div>';
      html += '<div class="historial-lista">' + activas.map(renderHistorialItem).join('') + '</div>';
    } else if (!query){
      html += '<div class="empty-state historial-seccion-vacia">No hay boletas con cobro pendiente.</div>';
    }

    if (archivadas.length > 0){
      html += '<div class="historial-seccion-titulo archivadas">Archivadas — pagadas <span class="count">(' + archivadas.length + ')</span></div>';
      html += '<div class="historial-lista historial-lista-archivadas">' + archivadas.map(renderHistorialItem).join('') + '</div>';
    }

    wrap.innerHTML = html;
  }
  window.renderHistorial = renderHistorial;

  /* ===================== recordatorio semanal de deudas ===================== */
  var MS_SEMANA = 7 * 24 * 60 * 60 * 1000;
  var boletasEnRecordatorioActual = [];

  function fechaCreacionBoleta(h){
    var raw = h.guardadoEn || h.fecha;
    if (!raw) return null;
    var d = new Date(raw);
    if (String(h.fecha || '').length === 10 && !h.guardadoEn){
      var p = h.fecha.split('-');
      d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    }
    return isNaN(d.getTime()) ? null : d;
  }

  function semanasDesdeCreacionBoleta(h){
    var creada = fechaCreacionBoleta(h);
    if (!creada) return 0;
    return Math.floor((Date.now() - creada.getTime()) / MS_SEMANA);
  }

  function boletaDebeRecordarDeuda(h){
    if (h.pagada) return false;
    var semanas = semanasDesdeCreacionBoleta(h);
    if (semanas < 1) return false;
    var ultimo = typeof h.recordatorioSemana === 'number' ? h.recordatorioSemana : 0;
    return semanas > ultimo;
  }

  function agruparDeudasParaRecordatorio(){
    var mapa = {};
    historial.forEach(function(h){
      if (!boletaDebeRecordarDeuda(h)) return;
      var nombre = (h.cliente || '').trim() || 'Sin nombre de cliente';
      var key = nombre.toLowerCase();
      if (!mapa[key]){
        mapa[key] = { nombre: nombre, boletas: [], total: 0 };
      }
      mapa[key].boletas.push(h);
      mapa[key].total += isFinite(h.total) ? h.total : 0;
    });
    return Object.keys(mapa).map(function(k){ return mapa[k]; })
      .sort(function(a, b){ return b.total - a.total; });
  }

  function marcarRecordatorioDeudasMostrado(){
    boletasEnRecordatorioActual.forEach(function(h){
      h.recordatorioSemana = semanasDesdeCreacionBoleta(h);
    });
    boletasEnRecordatorioActual = [];
    persistirLocalStorage();
  }

  function cerrarRecordatorioDeudas(){
    var overlay = document.getElementById('recordatorio-deudas-overlay');
    if (overlay) overlay.classList.remove('show');
    marcarRecordatorioDeudasMostrado();
    verificarLimpiezaArchivoHistorial();
  }

  function mostrarRecordatorioDeudasSiCorresponde(){
    var grupos = agruparDeudasParaRecordatorio();
    if (grupos.length === 0) return;

    boletasEnRecordatorioActual = [];
    grupos.forEach(function(g){
      g.boletas.forEach(function(h){ boletasEnRecordatorioActual.push(h); });
    });

    var lista = document.getElementById('recordatorio-deudas-lista');
    var overlay = document.getElementById('recordatorio-deudas-overlay');
    if (!lista || !overlay) return;

    lista.innerHTML = grupos.map(function(g){
      var n = g.boletas.length;
      var detalle = n === 1
        ? ('Boleta N° ' + escapeHtml(g.boletas[0].numero || '—'))
        : (n + ' boletas pendientes');
      return '<li class="recordatorio-deuda-item">' +
        '<div class="recordatorio-deuda-cliente">' + escapeHtml(g.nombre) + '</div>' +
        '<div class="recordatorio-deuda-meta">' + detalle + '</div>' +
        '<div class="recordatorio-deuda-total mono">' + money(g.total) + '</div>' +
      '</li>';
    }).join('');

    overlay.classList.add('show');
  }

  /* ===================== limpieza de archivadas antiguas ===================== */
  var LIMPIEZA_ARCHIVO_CANTIDAD = 50;
  var LIMPIEZA_ARCHIVO_DIAS = 30;
  var loteLimpiezaArchivoPendiente = [];

  function limpiezaArchivoPostergada(){
    try{
      var snooze = parseInt(localStorage.getItem('soderia_limpieza_snooze') || '0', 10);
      return snooze && (Date.now() - snooze) < MS_SEMANA;
    }catch(e){ return false; }
  }

  function postergarLimpiezaArchivo(){
    try{ localStorage.setItem('soderia_limpieza_snooze', String(Date.now())); }catch(e){}
  }

  function fechaReferenciaArchivo(h){
    return h.pagadaEn || h.guardadoEn || h.fecha;
  }

  function diasDesdeFecha(valor){
    if (!valor) return 0;
    var d = new Date(valor);
    if (isNaN(d.getTime())) return 0;
    return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
  }

  function boletasArchivadasAntiguasElegibles(){
    return historial.filter(function(h){
      if (!h.pagada) return false;
      return diasDesdeFecha(fechaReferenciaArchivo(h)) >= LIMPIEZA_ARCHIVO_DIAS;
    }).sort(function(a, b){
      return new Date(fechaReferenciaArchivo(a)).getTime() - new Date(fechaReferenciaArchivo(b)).getTime();
    });
  }

  function textoLimpiezaArchivoParaWhatsapp(boletas){
    var negocio = (document.getElementById('b-negocio') && document.getElementById('b-negocio').value) || 'Soderia Lardelli';
    var L = [];
    L.push('*Respaldo ' + negocio + '*');
    L.push(boletas.length + ' boletas archivadas (ya pagadas)');
    L.push('Exportado: ' + new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }));
    L.push('');
    var total = 0;
    boletas.forEach(function(h){
      total += isFinite(h.total) ? h.total : 0;
      var cliente = h.cliente || 'Sin cliente';
      L.push('• N°' + (h.numero || '—') + ' · ' + formatearFechaLegible(h.fecha) + ' · ' + cliente + ' · ' + money(h.total));
    });
    L.push('');
    L.push('*Total respaldado: ' + money(total) + '*');
    return L.join('\n');
  }

  function cerrarLimpiezaArchivo(){
    var overlay = document.getElementById('limpieza-archivo-overlay');
    if (overlay) overlay.classList.remove('show');
    loteLimpiezaArchivoPendiente = [];
  }

  function ejecutarLimpiezaArchivo(){
    if (!loteLimpiezaArchivoPendiente.length) return;
    if (!confirm('Se van a borrar ' + loteLimpiezaArchivoPendiente.length + ' boletas del historial después de abrir WhatsApp. ¿Continuar?')) return;

    var lote = loteLimpiezaArchivoPendiente.slice();
    var ids = {};
    lote.forEach(function(h){ ids[h.id] = true; });

    abrirWhatsappConTexto(textoLimpiezaArchivoParaWhatsapp(lote));
    historial = historial.filter(function(h){ return !ids[h.id]; });
    persistirLocalStorage();
    renderHistorial();
    cerrarLimpiezaArchivo();
    try{ localStorage.removeItem('soderia_limpieza_snooze'); }catch(e){}
    mostrarAviso(lote.length + ' boletas respaldadas y eliminadas del historial ✅');
  }

  function verificarLimpiezaArchivoHistorial(){
    if (limpiezaArchivoPostergada()) return;

    var elegibles = boletasArchivadasAntiguasElegibles();
    if (elegibles.length < LIMPIEZA_ARCHIVO_CANTIDAD) return;

    loteLimpiezaArchivoPendiente = elegibles.slice(0, LIMPIEZA_ARCHIVO_CANTIDAD);

    var intro = document.getElementById('limpieza-archivo-intro');
    var overlay = document.getElementById('limpieza-archivo-overlay');
    if (!intro || !overlay) return;

    var restantes = elegibles.length - loteLimpiezaArchivoPendiente.length;
    intro.textContent = 'Tenés ' + elegibles.length + ' boletas archivadas con más de ' + LIMPIEZA_ARCHIVO_DIAS + ' días. ' +
      'Para que la app vaya más liviana, podés exportar las ' + loteLimpiezaArchivoPendiente.length + ' más antiguas por WhatsApp y borrarlas del historial (ya están pagas).' +
      (restantes > 0 ? ' Quedarían ' + restantes + ' para una próxima limpieza.' : '');

    overlay.classList.add('show');
  }

  function mostrarAvisosInicio(){
    var overlayDeudas = document.getElementById('recordatorio-deudas-overlay');
    var habiaDeudas = false;
    if (overlayDeudas){
      var grupos = agruparDeudasParaRecordatorio();
      habiaDeudas = grupos.length > 0;
    }
    mostrarRecordatorioDeudasSiCorresponde();
    if (!habiaDeudas) verificarLimpiezaArchivoHistorial();
  }

  function buscarEnHistorial(id){
    return historial.find(function(h){ return h.id === id; });
  }

  window.marcarPagoHistorial = function(id, pagada){
    var h = buscarEnHistorial(id);
    if (!h) return;
    h.pagada = !!pagada;
    h.archivada = h.pagada;
    if (h.pagada) h.pagadaEn = new Date().toISOString();
    else delete h.pagadaEn;
    persistirLocalStorage();
    renderHistorial();
    if (historialDetalleAbiertoId === id) verDetalleHistorial(id);
    mostrarAviso(h.pagada ? 'Boleta pagada y archivada ✅' : 'Pago pendiente · boleta activa');
  };

  window.compartirDesdeHistorial = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    abrirWhatsappConTexto(textoBoletaParaWhatsapp(h));
  };

  window.eliminarDeHistorial = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    var etiqueta = h.cliente ? ('de "' + h.cliente + '"') : ('N° ' + h.numero);
    if (!confirm('¿Eliminar la boleta ' + etiqueta + ' del historial? Esta acción no se puede deshacer.')) return;
    historial = historial.filter(function(x){ return x.id !== id; });
    persistirLocalStorage();
    renderHistorial();
    mostrarAviso('Boleta eliminada del historial');
  };

  window.verDetalleHistorial = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    var clienteHtml = h.cliente ? escapeHtml(h.cliente) : '<span style="color:var(--muted); font-style:italic;">Sin nombre de cliente</span>';

    var lineasHtml = h.lineas.map(function(l){
      return '<div class="receipt-line">' +
        '<span class="nombre" title="' + escapeHtml(l.nombre) + '">' + escapeHtml(l.nombre) + '</span>' +
        '<span class="cant">' + l.cantidad + '</span>' +
        '<span class="punit">' + fmt.format(l.precio) + '</span>' +
        '<span class="sub">' + fmt.format(l.subtotal) + '</span>' +
      '</div>';
    }).join('');

    var html =
      '<div class="receipt-card" style="box-shadow:none;">' +
        '<div class="receipt-biz" style="cursor:default;">' + escapeHtml(h.negocio || 'Boleta') + '</div>' +
        '<div class="receipt-meta">' +
          '<div class="row"><label>N°</label><span class="mono">' + escapeHtml(h.numero || '—') + '</span></div>' +
          '<div class="row"><label>Fecha</label><span class="mono">' + formatearFechaLegible(h.fecha) + '</span></div>' +
          '<div class="row"><label>Cliente</label><span class="mono">' + clienteHtml + '</span></div>' +
          '<div class="row pago-detalle-row"><label>Pago</label>' + htmlPagoBoleta(h, 'historial-detalle-pagada') + '</div>' +
        '</div>' +
        '<div class="dashed"></div>' +
        '<div class="receipt-cols"><span>Producto</span><span>Cant.</span><span>P.Unit</span><span>Subt.</span></div>' +
        '<div class="receipt-items">' + lineasHtml + '</div>' +
        '<div class="dashed"></div>' +
        '<div class="receipt-totales">' +
          '<div class="row"><span>Subtotal</span><span class="v mono">' + money(h.subtotal) + '</span></div>' +
          (h.descuentoMonto > 0 ? '<div class="row"><span>Descuento</span><span class="v mono">-' + money(h.descuentoMonto) + '</span></div>' : '') +
          '<div class="row total"><span>Total</span><span class="v mono">' + money(h.total) + '</span></div>' +
        '</div>' +
        '<div class="receipt-footer-note">Gracias por su compra.</div>' +
      '</div>';

    document.getElementById('historial-detalle-body').innerHTML = html;
    historialDetalleAbiertoId = id;
    document.getElementById('historial-overlay').classList.add('show');
  };

  window.cerrarDetalleHistorial = function(){
    historialDetalleAbiertoId = null;
    document.getElementById('historial-overlay').classList.remove('show');
  };

  window.reabrirBoletaDeHistorial = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    if (!resolverBoletaPendienteAntesDeReemplazar(
      '¿Guardar la boleta actual en el historial antes de abrir otra?',
      '¿Abrir la boleta del historial sin guardar la actual? Se perderá la boleta actual.'
    )) return;

    cantidades = {};
    itemsManuales = [];
    h.lineas.forEach(function(l){
      var prod = productos.find(function(p){ return p.nombre === l.nombre && p.precio === l.precio; });
      if (prod){
        cantidades[prod.id] = (cantidades[prod.id] || 0) + l.cantidad;
      } else {
        itemsManuales.push({ id: uid(), nombre: l.nombre, precio: l.precio, cantidad: l.cantidad });
      }
    });

    document.getElementById('b-numero').value = h.numero || '';
    document.getElementById('b-fecha').value = h.fecha || hoyISO();
    document.getElementById('b-cliente').value = h.cliente || '';
    validarClienteBoleta(false);
    document.getElementById('b-descuento').value = h.descuentoMonto || 0;
    document.getElementById('b-descuento-tipo').value = 'monto';

    cerrarDetalleHistorial();
    cambiarTab('boleta');
    renderListaBoleta();
    renderResumenBoleta();
    mostrarAviso('Boleta reabierta para editar 🧾');
  };


  /* ===================== imprimir lista de precios ===================== */
  window.imprimirListaPrecios = function(){
    if (productos.length === 0){
      mostrarAviso('Todavía no hay productos para imprimir');
      return;
    }
    var negocio = (document.getElementById('b-negocio').value || 'Soderia Lardelli').trim();
    var fechaLegible = new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
    var totalProductos = productos.length;

    var gruposMap = {};
    var ordenGrupos = [];
    categorias.forEach(function(c){ gruposMap[c.id] = []; ordenGrupos.push(c.id); });
    gruposMap['__sin__'] = [];

    productos.forEach(function(p){
      var key = (p.categoriaId && gruposMap.hasOwnProperty(p.categoriaId)) ? p.categoriaId : '__sin__';
      gruposMap[key].push(p);
    });
    ordenGrupos.push('__sin__');

    var seccionesHtml = ordenGrupos.map(function(catId){
      var items = gruposMap[catId];
      if (!items || items.length === 0) return '';
      var titulo = catId === '__sin__' ? 'Sin categoría' : (categoriaPorId(catId) ? categoriaPorId(catId).nombre : 'Sin categoría');
      var filas = items.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre, 'es'); }).map(function(p){
        return '<tr><td class="prod">' + escapeHtml(p.nombre) + (p.codigo ? '<span class="cod">#' + escapeHtml(p.codigo) + '</span>' : '') + '</td><td class="precio">' + money(p.precio) + '</td></tr>';
      }).join('');
      return '<section class="bloque"><h2>' + escapeHtml(titulo) + ' <span class="cant">' + items.length + '</span></h2>' +
        '<table><thead><tr><th>Producto</th><th>Precio</th></tr></thead><tbody>' + filas + '</tbody></table></section>';
    }).join('');

    var doc = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>' + escapeHtml(negocio) + ' — Lista de precios</title>' +
      '<style>' +
      '@page{ margin:12mm; size:A4; }' +
      '*{ box-sizing:border-box; }' +
      'body{ font-family:Arial,Helvetica,sans-serif; color:#111; margin:0; font-size:12px; line-height:1.35; }' +
      'header{ text-align:center; padding-bottom:12px; margin-bottom:16px; border-bottom:1px solid #222; }' +
      'header h1{ font-size:18px; margin:0 0 4px; font-weight:700; letter-spacing:-.01em; }' +
      'header .meta{ font-size:11px; color:#555; }' +
      '.bloque{ margin-bottom:18px; page-break-inside:avoid; }' +
      'h2{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#333; margin:0 0 6px; font-weight:700; border-bottom:1px solid #ccc; padding-bottom:4px; }' +
      'h2 .cant{ font-weight:400; color:#777; text-transform:none; letter-spacing:0; }' +
      'table{ width:100%; border-collapse:collapse; }' +
      'thead th{ text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#666; border-bottom:1px solid #222; padding:4px 2px 5px; font-weight:700; }' +
      'thead th:last-child{ text-align:right; }' +
      'td{ padding:4px 2px; border-bottom:1px solid #e8e8e8; vertical-align:top; }' +
      'td.prod{ width:72%; }' +
      'td.precio{ text-align:right; font-weight:700; white-space:nowrap; }' +
      '.cod{ color:#777; font-size:10px; margin-left:6px; }' +
      'footer{ margin-top:20px; padding-top:10px; border-top:1px solid #ccc; text-align:center; font-size:10px; color:#666; }' +
      '</style></head><body>' +
      '<header><h1>' + escapeHtml(negocio) + '</h1>' +
      '<div class="meta">Lista de precios · ' + fechaLegible + ' · ' + totalProductos + ' productos</div></header>' +
      seccionesHtml +
      '<footer>Precios sujetos a modificación sin previo aviso.</footer>' +
      '</body></html>';

    var ventana = window.open('', '_blank');
    if (!ventana){
      mostrarAviso('Permití ventanas emergentes para imprimir la lista');
      return;
    }
    ventana.document.open();
    ventana.document.write(doc);
    ventana.document.close();
    ventana.focus();
    setTimeout(function(){ ventana.print(); }, 300);
    mostrarAviso('Lista de precios lista para imprimir 🖨️');
  };
  window.descargarListaPreciosPDF = window.imprimirListaPrecios;
/* ===================== toast ===================== */
  var avisoTimeout;
  function mostrarAviso(texto){
    var el = document.getElementById('aviso');
    el.textContent = texto;
    el.classList.add('show');
    clearTimeout(avisoTimeout);
    avisoTimeout = setTimeout(function(){ el.classList.remove('show'); }, 2400);
  }

  /* ===================== eventos de la interfaz ===================== */
  function bindEventosUI(){
    var tabProductos = document.getElementById('tab-btn-productos');
    var tabBoleta = document.getElementById('tab-btn-boleta');
    var tabHistorial = document.getElementById('tab-btn-historial');
    if (tabProductos) tabProductos.addEventListener('click', function(){ cambiarTab('productos'); });
    if (tabBoleta) tabBoleta.addEventListener('click', function(){ cambiarTab('boleta'); });
    if (tabHistorial) tabHistorial.addEventListener('click', function(){ cambiarTab('historial'); });

    var formProducto = document.getElementById('form-producto');
    var formCategoria = document.getElementById('form-categoria');
    var formCliente = document.getElementById('form-cliente');
    if (formProducto) formProducto.addEventListener('submit', guardarProducto);
    if (formCategoria) formCategoria.addEventListener('submit', guardarCategoria);
    if (formCliente) formCliente.addEventListener('submit', guardarCliente);

    var btnCancelarProducto = document.getElementById('btn-cancelar-producto');
    var btnCancelarCategoria = document.getElementById('btn-cancelar-categoria');
    var btnCancelarCliente = document.getElementById('btn-cancelar-cliente');
    if (btnCancelarProducto) btnCancelarProducto.addEventListener('click', cancelarEdicion);
    if (btnCancelarCategoria) btnCancelarCategoria.addEventListener('click', cancelarEdicionCategoria);
    if (btnCancelarCliente) btnCancelarCliente.addEventListener('click', cancelarEdicionCliente);

    var btnImprimirLista = document.getElementById('btn-imprimir-lista');
    var btnImprimirBoleta = document.getElementById('btn-imprimir-boleta');
    var btnWhatsappBoleta = document.getElementById('btn-whatsapp-boleta');
    var btnNuevaBoleta = document.getElementById('btn-nueva-boleta');
    var btnGuardarHistorial = document.getElementById('btn-guardar-historial');
    var btnCerrarHistorial = document.getElementById('btn-cerrar-historial');
    if (btnImprimirLista) btnImprimirLista.addEventListener('click', imprimirListaPrecios);
    if (btnImprimirBoleta) btnImprimirBoleta.addEventListener('click', imprimirBoleta);
    if (btnWhatsappBoleta) btnWhatsappBoleta.addEventListener('click', compartirWhatsapp);
    if (btnNuevaBoleta) btnNuevaBoleta.addEventListener('click', nuevaBoleta);
    if (btnGuardarHistorial) btnGuardarHistorial.addEventListener('click', guardarEnHistorial);
    if (btnCerrarHistorial) btnCerrarHistorial.addEventListener('click', cerrarDetalleHistorial);

    var btnRecordatorioOk = document.getElementById('btn-recordatorio-deudas-ok');
    var btnRecordatorioHistorial = document.getElementById('btn-recordatorio-deudas-historial');
    var overlayRecordatorio = document.getElementById('recordatorio-deudas-overlay');
    if (btnRecordatorioOk) btnRecordatorioOk.addEventListener('click', cerrarRecordatorioDeudas);
    if (btnRecordatorioHistorial){
      btnRecordatorioHistorial.addEventListener('click', function(){
        cerrarRecordatorioDeudas();
        cambiarTab('historial');
      });
    }
    if (overlayRecordatorio){
      overlayRecordatorio.addEventListener('click', function(ev){
        if (ev.target === overlayRecordatorio) cerrarRecordatorioDeudas();
      });
    }

    var btnLimpiezaWpp = document.getElementById('btn-limpieza-archivo-wpp');
    var btnLimpiezaPostergar = document.getElementById('btn-limpieza-archivo-postergar');
    var overlayLimpieza = document.getElementById('limpieza-archivo-overlay');
    if (btnLimpiezaWpp) btnLimpiezaWpp.addEventListener('click', ejecutarLimpiezaArchivo);
    if (btnLimpiezaPostergar){
      btnLimpiezaPostergar.addEventListener('click', function(){
        postergarLimpiezaArchivo();
        cerrarLimpiezaArchivo();
        mostrarAviso('Limpieza pospuesta una semana');
      });
    }
    if (overlayLimpieza){
      overlayLimpieza.addEventListener('click', function(ev){
        if (ev.target === overlayLimpieza){
          postergarLimpiezaArchivo();
          cerrarLimpiezaArchivo();
        }
      });
    }

    var btnVerBoleta = document.getElementById('btn-ver-boleta');
    if (btnVerBoleta){
      btnVerBoleta.addEventListener('click', function(){
        var el = document.getElementById('boleta-imprimible');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    var overlay = document.getElementById('historial-overlay');
    if (overlay){
      overlay.addEventListener('click', function(ev){
        if (ev.target === overlay) cerrarDetalleHistorial();
      });
    }

    var btnWppDetalle = document.getElementById('historial-detalle-wpp-btn');
    var btnReabrirDetalle = document.getElementById('historial-detalle-reabrir-btn');
    var btnEliminarDetalle = document.getElementById('historial-detalle-eliminar-btn');
    if (btnWppDetalle){
      btnWppDetalle.addEventListener('click', function(){
        if (historialDetalleAbiertoId) compartirDesdeHistorial(historialDetalleAbiertoId);
      });
    }
    if (btnReabrirDetalle){
      btnReabrirDetalle.addEventListener('click', function(){
        if (historialDetalleAbiertoId) reabrirBoletaDeHistorial(historialDetalleAbiertoId);
      });
    }
    if (btnEliminarDetalle){
      btnEliminarDetalle.addEventListener('click', function(){
        if (!historialDetalleAbiertoId) return;
        eliminarDeHistorial(historialDetalleAbiertoId);
        cerrarDetalleHistorial();
      });
    }

    var buscador = document.getElementById('buscador');
    var buscadorCatalogo = document.getElementById('buscador-catalogo');
    var buscadorHistorial = document.getElementById('buscador-historial');
    if (buscador) buscador.addEventListener('input', renderListaBoleta);
    if (buscadorCatalogo) buscadorCatalogo.addEventListener('input', renderProductos);
    if (buscadorHistorial) buscadorHistorial.addEventListener('input', renderHistorial);

    var bNegocio = document.getElementById('b-negocio');
    var bCliente = document.getElementById('b-cliente');
    var bDescuento = document.getElementById('b-descuento');
    var bDescuentoTipo = document.getElementById('b-descuento-tipo');
    if (bNegocio) bNegocio.addEventListener('input', guardarNegocio);
    if (bCliente){
      bCliente.addEventListener('input', function(){ validarClienteBoleta(false); });
      bCliente.addEventListener('change', normalizarClienteBoleta);
      bCliente.addEventListener('blur', normalizarClienteBoleta);
    }
    if (bDescuento) bDescuento.addEventListener('input', renderResumenBoleta);
    if (bDescuentoTipo) bDescuentoTipo.addEventListener('change', renderResumenBoleta);

    var pinBtn = document.getElementById('pin-btn');
    var pinInput = document.getElementById('pin-input');
    if (pinBtn && pinInput){
      function intentarPin(){
        var pinCfg = (getConfig().FAMILY_PIN || '').trim();
        if (!pinCfg){
          mostrarAviso('No hay clave configurada. Revisá config.js o los Secrets de GitHub.');
          return;
        }
        if (pinInput.value.trim() === pinCfg){
          sessionStorage.setItem('soderia_pin_ok', '1');
          var gate = document.getElementById('pin-gate');
          if (gate){
            gate.classList.remove('show');
            gate.setAttribute('aria-hidden', 'true');
          }
          if (pinResolver){
            pinResolver(true);
            pinResolver = null;
          }
        } else {
          mostrarAviso('Clave incorrecta');
          pinInput.select();
        }
      }
      pinBtn.addEventListener('click', intentarPin);
      pinInput.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter') intentarPin();
      });
    }

    document.body.addEventListener('click', function(ev){
      var btn = ev.target.closest('[data-action]');
      if (!btn) return;
      if (btn.getAttribute('data-action') === 'toggle-pago-historial') return;
      var action = btn.getAttribute('data-action');
      var id = btn.getAttribute('data-id') || '';
      switch (action){
        case 'editar-categoria': editarCategoria(id); break;
        case 'eliminar-categoria': eliminarCategoria(id); break;
        case 'editar-cliente': editarCliente(id); break;
        case 'eliminar-cliente': eliminarCliente(id); break;
        case 'editar-producto': editarProducto(id); break;
        case 'eliminar-producto': eliminarProducto(id); break;
        case 'filtro-categoria': setFiltroCategoriaBoleta(btn.getAttribute('data-cat') || ''); break;
        case 'quitar-manual': quitarManual(id); break;
        case 'quitar-producto':
          cambiarCantidad(id, -parseInt(btn.getAttribute('data-cant') || '1', 10));
          break;
        case 'ver-historial': verDetalleHistorial(id); break;
        case 'wpp-historial': compartirDesdeHistorial(id); break;
        case 'eliminar-historial': eliminarDeHistorial(id); break;
      }
    });

    document.body.addEventListener('change', function(ev){
      var el = ev.target;
      if (!el || el.getAttribute('data-action') !== 'toggle-pago-historial') return;
      marcarPagoHistorial(el.getAttribute('data-id') || '', el.checked);
    });
  }

  /* ===================== PWA: instalar como app ===================== */
  var deferredInstallPrompt = null;

  function esContextoInstalable(){
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function actualizarHintPwa(){
    var hint = document.getElementById('pwa-hint');
    if (!hint || esContextoInstalable()) return;
    hint.textContent = 'Para instalar como app, abrila desde http://localhost (no como archivo suelto).';
    hint.classList.add('show');
  }

  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredInstallPrompt = e;
    var btn = document.getElementById('btn-install-app');
    if (btn){
      btn.hidden = false;
      btn.classList.add('show');
    }
  });

  document.addEventListener('DOMContentLoaded', async function(){
    bindEventosUI();

    window.addEventListener('beforeunload', function(ev){
      if (!hayBoletaPendiente()) return;
      ev.preventDefault();
      ev.returnValue = '';
    });

    if (!configDisponible()){
      mostrarErrorConfigFaltante();
      return;
    }

    var btnInstall = document.getElementById('btn-install-app');
    if (btnInstall){
      btnInstall.addEventListener('click', function(){
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(function(choice){
          if (choice.outcome === 'accepted'){
            mostrarAviso('App instalada ✅');
          }
          deferredInstallPrompt = null;
          btnInstall.hidden = true;
          btnInstall.classList.remove('show');
        });
      });
    }
    actualizarHintPwa();

    if ('serviceWorker' in navigator && esContextoInstalable()){
      navigator.serviceWorker.register('sw.js').catch(function(err){
        console.warn('No se pudo registrar el service worker', err);
      });
    }

    var pinOk = await asegurarAccesoFamilia();
    if (!pinOk) return;
    await cargarDatos();
    cancelarEdicion();
    document.getElementById('b-fecha').value = hoyISO();
    actualizarNumeroBoleta();
    bindStepperBoleta();
    renderCategorias();
    renderSelectCategoriaProducto();
    renderProductos();
    renderFiltrosCategoriaBoleta();
    renderListaBoleta();
    renderResumenBoleta();
    actualizarStatHistorial();
    renderClientes();
    mostrarAvisosInicio();
  });
})();