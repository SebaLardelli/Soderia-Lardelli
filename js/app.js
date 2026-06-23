(function(){
  "use strict";

  /* ===================== estado ===================== */
  var productos = [];           // {id, nombre, precio, codigo, categoriaId}
  var categorias = [];          // {id, nombre}
  var categoriaFiltro = '';     // '' = todas
  var contadorBoleta = 1;
  var contadorBoletaManual = false;
  var cantidades = {};          // productoId -> cantidad elegida en la boleta actual
  var itemsManuales = [];       // [{id, nombre, precio, cantidad}]
  var editandoId = null;
  var editandoCategoriaId = null;
  var historial = [];           // [{id, numero, fecha, cliente, lineas, subtotal, descuentoMonto, total, negocio, guardadoEn}]
  var clientes = [];            // {id, nombre}
  var editandoClienteId = null;
  var boletaReeditandoId = null;
  var boletaGuardadaActivaId = null;
  var snapshotBoletaGuardada = null;
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

  function numeroBoletaNumerico(valor){
    var n = parseInt(String(valor || '').replace(/\D/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function recalcularContadorBoletaTrasEliminar(){
    if (historial.length === 0){
      contadorBoleta = 1;
    } else {
      var max = 0;
      historial.forEach(function(h){
        var n = numeroBoletaNumerico(h.numero);
        if (n > max) max = n;
      });
      contadorBoleta = Math.max(1, max + 1);
    }
    if (!boletaReeditandoId) actualizarNumeroBoleta();
  }

  function sincronizarContadorBoleta(){
    if (contadorBoletaManual) return;
    var max = 0;
    historial.forEach(function(h){
      var n = numeroBoletaNumerico(h.numero);
      if (n > max) max = n;
    });
    if (max >= contadorBoleta) contadorBoleta = max + 1;
  }

  function hayBoletaPendiente(){
    return calcularBoleta().lineas.length > 0;
  }

  function ofrecerGuardarBoletaPendiente(mensaje){
    if (!hayBoletaSinGuardar()) return true;
    if (confirm(mensaje || 'Tenés productos en la boleta sin guardar en el historial. ¿Querés guardarla ahora?')){
      return guardarBoletaEnHistorialInterno();
    }
    return true;
  }

  function confirmarDescartarBoletaPendiente(mensaje){
    if (!hayBoletaSinGuardar()) return true;
    return confirm(mensaje || '¿Continuar sin guardar? Se perderá la boleta actual.');
  }

  function resolverBoletaPendienteAntesDeReemplazar(mensajeGuardar, mensajeDescartar){
    if (!ofrecerGuardarBoletaPendiente(mensajeGuardar)) return false;
    if (hayBoletaSinGuardar() && !confirmarDescartarBoletaPendiente(mensajeDescartar)) return false;
    return true;
  }

  var historialDetalleAbiertoId = null;
  var clienteDetalleAbiertoId = null;
  var clienteNotaAbiertoId = null;
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

  function snapshotBoletaActual(){
    var calc = calcularBoleta();
    var pagadaEl = document.getElementById('b-pagada');
    return JSON.stringify({
      numero: document.getElementById('b-numero').value,
      fecha: document.getElementById('b-fecha').value,
      cliente: document.getElementById('b-cliente').value.trim(),
      descuento: document.getElementById('b-descuento').value,
      descuentoTipo: document.getElementById('b-descuento-tipo').value,
      pagada: pagadaEl ? pagadaEl.checked : false,
      lineas: calc.lineas.map(function(l){
        return { id: l.id, nombre: l.nombre, precio: l.precio, cantidad: l.cantidad, manual: !!l.manual };
      })
    });
  }

  function marcarBoletaGuardada(id){
    boletaGuardadaActivaId = id;
    snapshotBoletaGuardada = snapshotBoletaActual();
    aplicarBloqueoBoletaUI();
  }

  function limpiarBoletaGuardada(){
    boletaGuardadaActivaId = null;
    snapshotBoletaGuardada = null;
    aplicarBloqueoBoletaUI();
  }

  function boletaEstaBloqueada(){
    return boletaEstaGuardadaSinCambios();
  }

  function aplicarBloqueoBoletaUI(){
    var bloqueada = boletaEstaBloqueada();
    var panelBoleta = document.getElementById('panel-boleta');
    var cardProductos = document.querySelector('.card-boleta-productos');
    var avisoProductos = document.getElementById('boleta-productos-bloqueo');
    if (panelBoleta) panelBoleta.classList.toggle('boleta-guardada-activa', bloqueada);
    if (cardProductos) cardProductos.classList.toggle('boleta-edicion-bloqueada', bloqueada);
    if (avisoProductos) avisoProductos.hidden = !bloqueada;

    ['b-cliente', 'b-descuento', 'b-descuento-tipo', 'b-fecha'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.disabled = bloqueada;
    });
    var pagadaEl = document.getElementById('b-pagada');
    if (pagadaEl) pagadaEl.disabled = bloqueada;
    var buscadorBoleta = document.getElementById('buscador');
    if (buscadorBoleta) buscadorBoleta.disabled = bloqueada;

    var btnGuardar = document.getElementById('btn-guardar-historial');
    if (btnGuardar){
      btnGuardar.disabled = bloqueada;
      btnGuardar.title = bloqueada ? 'Esta boleta ya está guardada' : '';
    }

    actualizarEstadoBotonesBoletaAccion();
    renderListaBoleta();
    renderResumenBoleta();
  }

  function boletaEstaGuardadaSinCambios(){
    return !!(boletaGuardadaActivaId && snapshotBoletaGuardada && snapshotBoletaActual() === snapshotBoletaGuardada);
  }

  function hayBoletaSinGuardar(){
    if (!hayBoletaPendiente()) return false;
    return !boletaEstaGuardadaSinCambios();
  }

  function validarBoletaGuardadaParaAccion(){
    if (boletaEstaGuardadaSinCambios()) return true;
    if (boletaGuardadaActivaId){
      mostrarAviso('Hay cambios sin guardar. Guardá de nuevo para imprimir o compartir');
    } else {
      mostrarAviso('Primero guardá la boleta en el historial');
    }
    return false;
  }

  function actualizarEstadoBotonesBoletaAccion(){
    var puede = boletaEstaGuardadaSinCambios();
    var calc = calcularBoleta();
    var tieneLineas = calc.lineas.length > 0;
    var btnWpp = document.getElementById('btn-whatsapp-boleta');
    var btnImp = document.getElementById('btn-imprimir-boleta');
    var btnGuardar = document.getElementById('btn-guardar-historial');
    var grupo = document.getElementById('boleta-acciones-compartir');
    var aviso = document.getElementById('boleta-guardar-aviso');
    var avisoMsg = document.getElementById('boleta-guardar-aviso-msg');
    var avisoIcon = document.getElementById('boleta-guardar-aviso-icon');
    var estadoEl = document.getElementById('boleta-acciones-estado');
    var hintEl = document.getElementById('boleta-acciones-hint');

    if (btnWpp){
      btnWpp.disabled = !puede;
      btnWpp.setAttribute('aria-disabled', String(!puede));
    }
    if (btnImp){
      btnImp.disabled = !puede;
      btnImp.setAttribute('aria-disabled', String(!puede));
    }
    if (btnGuardar){
      btnGuardar.classList.toggle('destacar-guardar', tieneLineas && !puede);
      btnGuardar.disabled = puede;
    }
    if (grupo){
      grupo.classList.toggle('bloqueada', tieneLineas && !puede);
      grupo.classList.toggle('habilitada', puede);
    }

    if (!aviso || !avisoMsg) return;

    if (!tieneLineas){
      aviso.hidden = true;
      aviso.className = 'boleta-guardar-aviso';
      if (estadoEl) estadoEl.textContent = 'Requiere guardar';
      if (hintEl) hintEl.textContent = 'Disponible después de guardar la boleta en el historial.';
      return;
    }

    aviso.hidden = false;
    if (puede){
      aviso.className = 'boleta-guardar-aviso ok';
      if (avisoIcon) avisoIcon.textContent = '✅';
      avisoMsg.textContent = 'Boleta guardada. Imprimí, compartí por WhatsApp o empezá otra con «Nueva Boleta».';
      if (estadoEl) estadoEl.textContent = 'Lista para enviar';
      if (hintEl) hintEl.textContent = 'No podés modificar esta boleta. Para otra venta usá «Nueva Boleta».';
    } else if (boletaGuardadaActivaId){
      aviso.className = 'boleta-guardar-aviso warn cambios';
      if (avisoIcon) avisoIcon.textContent = '⚠️';
      avisoMsg.textContent = 'Modificaste la boleta. Guardá los cambios para volver a habilitar imprimir y compartir.';
      if (estadoEl) estadoEl.textContent = 'Cambios sin guardar';
      if (hintEl) hintEl.textContent = 'Volvé a usar «Guardar en Historial» antes de imprimir o compartir.';
    } else {
      aviso.className = 'boleta-guardar-aviso warn';
      if (avisoIcon) avisoIcon.textContent = '🔒';
      avisoMsg.textContent = 'Guardá la boleta en el historial para habilitar imprimir y compartir por WhatsApp.';
      if (estadoEl) estadoEl.textContent = 'Bloqueado';
      if (hintEl) hintEl.textContent = 'Paso obligatorio: primero «Guardar en Historial», después imprimir o compartir.';
    }
  }

  function datosBoletaDesdeHistorial(h){
    return {
      negocio: h.negocio || 'Boleta',
      numero: h.numero,
      fecha: h.fecha,
      cliente: h.cliente || '',
      lineas: h.lineas || [],
      subtotal: h.subtotal,
      descuentoMonto: h.descuentoMonto || 0,
      total: h.total
    };
  }

  function setBoletaFechaEditable(editable){
    var fechaEl = document.getElementById('b-fecha');
    if (!fechaEl) return;
    fechaEl.readOnly = !editable;
    fechaEl.title = editable ? '' : 'La fecha se conserva al editar una boleta guardada';
  }

  function mostrarBannerBoletaReeditando(h){
    limpiarBoletaGuardada();
    boletaReeditandoId = h.id;
    var banner = document.getElementById('boleta-reeditando-banner');
    var numEl = document.getElementById('boleta-reeditando-numero');
    if (banner) banner.style.display = 'flex';
    if (numEl) numEl.textContent = h.numero || '—';
    var btnGuardar = document.getElementById('btn-guardar-historial');
    if (btnGuardar) btnGuardar.textContent = '💾 Guardar cambios';
    setBoletaFechaEditable(false);
  }

  function ocultarBannerBoletaReeditando(){
    boletaReeditandoId = null;
    var banner = document.getElementById('boleta-reeditando-banner');
    if (banner) banner.style.display = 'none';
    var btnGuardar = document.getElementById('btn-guardar-historial');
    if (btnGuardar) btnGuardar.textContent = '📥 Guardar en historial';
    setBoletaFechaEditable(true);
  }

  window.cancelarReedicionBoleta = function(){
    if (!boletaReeditandoId) return;
    if (hayBoletaPendiente() && !confirm('¿Descartar los cambios de la boleta N° ' + (document.getElementById('b-numero').value || '—') + '?')) return;
    ocultarBannerBoletaReeditando();
    limpiarBoletaActual();
    actualizarNumeroBoleta();
    mostrarAviso('Edición cancelada');
  };

  function limpiarBoletaActual(){
    cantidades = {};
    itemsManuales = [];
    resetearFlagsBoletaSesion();
    limpiarBoletaGuardada();
    document.getElementById('b-descuento').value = 0;
    document.getElementById('b-cliente').value = '';
    document.getElementById('b-cliente').disabled = false;
    document.getElementById('b-descuento').disabled = false;
    document.getElementById('b-descuento-tipo').disabled = false;
    document.getElementById('b-fecha').disabled = false;
    document.getElementById('b-cliente').classList.remove('field-invalid', 'field-ok');
    document.getElementById('b-cliente-error').className = 'field-hint';
    document.getElementById('b-cliente-error').textContent = '';
    document.getElementById('b-fecha').value = hoyISO();
    var pagadaEl = document.getElementById('b-pagada');
    if (pagadaEl){
      pagadaEl.checked = false;
      pagadaEl.disabled = false;
    }
    var btnGuardar = document.getElementById('btn-guardar-historial');
    if (btnGuardar) btnGuardar.disabled = false;
    var buscadorBoleta = document.getElementById('buscador');
    if (buscadorBoleta) buscadorBoleta.disabled = false;
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
      contadorBoletaManual: contadorBoletaManual,
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
    if (h.montoPagado === undefined || h.montoPagado === null){
      h.montoPagado = h.pagada ? (h.total || 0) : 0;
    } else {
      h.montoPagado = Math.max(0, parseFloat(h.montoPagado) || 0);
    }
    if (!Array.isArray(h.abonos)) h.abonos = [];
    h.abonos = h.abonos.map(function(a){
      return {
        id: a.id || uid(),
        monto: Math.max(0, parseFloat(a.monto) || 0),
        fecha: a.fecha || hoyISO(),
        registradoEn: a.registradoEn || new Date().toISOString()
      };
    }).filter(function(a){ return a.monto > 0.004; });
    if (h.abonos.length === 0 && h.montoPagado > 0.004 && !h.pagada){
      h.abonos.push({
        id: uid(),
        monto: h.montoPagado,
        fecha: (h.pagadaEn || h.guardadoEn || h.fecha || hoyISO()).slice(0, 10),
        registradoEn: h.guardadoEn || new Date().toISOString()
      });
    }
    if (h.abonos.length > 0){
      var sumaAbonos = h.abonos.reduce(function(acc, a){ return acc + a.monto; }, 0);
      var total = isFinite(h.total) ? h.total : 0;
      h.montoPagado = Math.min(sumaAbonos, total);
    }
    if (h.recordatorioSemana === undefined) h.recordatorioSemana = 0;
    sincronizarEstadoPagoBoleta(h);
    return h;
  }

  function normalizarCliente(c){
    if (!c || typeof c !== 'object') return c;
    if (Array.isArray(c.recordatorios)){
      c.recordatorios = c.recordatorios.map(function(n){
        return {
          id: n.id || uid(),
          texto: String(n.texto || '').trim(),
          creadoEn: n.creadoEn || new Date().toISOString()
        };
      }).filter(function(n){ return n.texto; });
    } else if (c.notas && String(c.notas).trim()){
      c.recordatorios = [{ id: uid(), texto: String(c.notas).trim(), creadoEn: new Date().toISOString() }];
    } else {
      c.recordatorios = [];
    }
    delete c.notas;
    return c;
  }

  function htmlNotasCliente(c, opts){
    opts = opts || {};
    var notas = (c.recordatorios || []);
    if (notas.length === 0) return '';
    var chips = notas.map(function(n){
      return '<div class="cliente-nota-chip">' +
        '<span class="cliente-nota-icon" aria-hidden="true">📌</span>' +
        '<span class="cliente-nota-texto">' + escapeHtml(n.texto) + '</span>' +
        '<button type="button" class="cliente-nota-borrar" title="Quitar nota" data-action="eliminar-nota-cliente" data-id="' + escapeHtml(c.id) + '" data-nota-id="' + escapeHtml(n.id) + '">✕</button>' +
      '</div>';
    }).join('');
    var lista = '<div class="cliente-notas-lista' + (opts.detalle ? ' cliente-notas-lista--detalle' : '') + '">' + chips + '</div>';
    if (opts.detalle) return lista;
    return '<div class="cliente-notas-block">' +
      '<div class="cliente-notas-etiqueta">Notas</div>' +
      lista +
    '</div>';
  }

  function htmlFormNotaCliente(c, inputId){
    inputId = inputId || ('cliente-nota-input-' + c.id);
    return '<div class="cliente-nota-form">' +
      '<input type="text" id="' + inputId + '" class="cliente-nota-input" placeholder="Ej: paga los viernes, deja bidones en el portón" maxlength="200">' +
      '<div class="cliente-nota-form-acciones">' +
        '<button type="button" class="btn btn-primary btn-sm" data-action="guardar-nota-cliente" data-id="' + escapeHtml(c.id) + '" data-input-id="' + inputId + '">Agregar</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="cancelar-nota-cliente">Cancelar</button>' +
      '</div>' +
    '</div>';
  }

  window.abrirFormNotaCliente = function(id){
    clienteNotaAbiertoId = id;
    renderClientes();
    if (clienteDetalleAbiertoId === id) verDetalleCliente(id);
    setTimeout(function(){
      var input = document.getElementById('cliente-nota-input-' + id) || document.getElementById('cliente-nota-input-detalle');
      if (input) input.focus();
    }, 30);
  };

  window.cancelarFormNotaCliente = function(){
    clienteNotaAbiertoId = null;
    renderClientes();
    if (clienteDetalleAbiertoId) verDetalleCliente(clienteDetalleAbiertoId);
  };

  window.guardarNotaClienteDesdeForm = function(id, inputId){
    var c = clientePorId(id);
    if (!c) return;
    var input = document.getElementById(inputId || ('cliente-nota-input-' + id));
    if (!input){
      mostrarAviso('No se encontró el campo de la nota');
      return;
    }
    var texto = (input.value || '').trim();
    if (!texto){
      mostrarAviso('Escribí la nota antes de agregar');
      input.focus();
      return;
    }
    if (!Array.isArray(c.recordatorios)) c.recordatorios = [];
    c.recordatorios.push({ id: uid(), texto: texto, creadoEn: new Date().toISOString() });
    clienteNotaAbiertoId = null;
    persistirLocalStorage();
    renderClientes();
    if (clienteDetalleAbiertoId === id) verDetalleCliente(id);
    mostrarAviso('Nota agregada ✅');
  };

  window.agregarNotaCliente = function(id){
    abrirFormNotaCliente(id);
  };

  window.eliminarNotaCliente = function(clienteId, notaId){
    var c = clientePorId(clienteId);
    if (!c || !Array.isArray(c.recordatorios)) return;
    c.recordatorios = c.recordatorios.filter(function(n){ return n.id !== notaId; });
    persistirLocalStorage();
    renderClientes();
    if (clienteDetalleAbiertoId === clienteId) verDetalleCliente(clienteId);
    mostrarAviso('Nota eliminada');
  };

  function montoPagadoBoleta(h){
    if (!h) return 0;
    var p = parseFloat(h.montoPagado);
    if (isNaN(p) || p < 0) return 0;
    var total = isFinite(h.total) ? h.total : 0;
    return Math.min(p, total);
  }

  function saldoPendienteBoleta(h){
    if (!h) return 0;
    var total = isFinite(h.total) ? h.total : 0;
    return Math.max(0, total - montoPagadoBoleta(h));
  }

  function boletaEstaPagada(h){
    return saldoPendienteBoleta(h) <= 0.004;
  }

  function boletaEsParcial(h){
    return !boletaEstaPagada(h) && montoPagadoBoleta(h) > 0.004;
  }

  function sincronizarEstadoPagoBoleta(h){
    if (!h) return;
    var saldo = saldoPendienteBoleta(h);
    if (saldo <= 0.004){
      h.pagada = true;
      h.archivada = true;
      h.montoPagado = h.total || 0;
    } else {
      h.pagada = false;
      h.archivada = false;
      delete h.pagadaEn;
    }
  }

  function etiquetaPagoBoleta(h){
    if (boletaEstaPagada(h)) return 'Pagada';
    if (boletaEsParcial(h)) return 'Parcial · debe ' + money(saldoPendienteBoleta(h));
    return 'Pago pendiente';
  }

  function recalcularTotalesBoletaHistorial(h){
    var subtotal = 0;
    (h.lineas || []).forEach(function(l){
      var precio = parseFloat(l.precio) || 0;
      var cant = parseFloat(l.cantidad) || 0;
      l.subtotal = precio * cant;
      subtotal += l.subtotal;
    });
    h.subtotal = subtotal;
    var descuento = Math.max(0, parseFloat(h.descuentoMonto) || 0);
    if (descuento > subtotal) descuento = subtotal;
    h.descuentoMonto = descuento;
    h.total = Math.max(0, subtotal - descuento);
  }

  function ajustarPagosBoletaTrasCambioTotal(h){
    var total = h.total || 0;
    var pagado = montoPagadoBoleta(h);
    if (pagado > total + 0.004){
      if (Array.isArray(h.abonos) && h.abonos.length > 0){
        var acum = 0;
        var nuevos = [];
        h.abonos.forEach(function(abono){
          if (acum >= total - 0.004) return;
          var resto = total - acum;
          if (abono.monto <= resto + 0.004){
            nuevos.push(abono);
            acum += abono.monto;
          } else if (resto > 0.004){
            nuevos.push({
              id: abono.id,
              monto: resto,
              fecha: abono.fecha,
              registradoEn: abono.registradoEn
            });
            acum = total;
          }
        });
        h.abonos = nuevos;
        h.montoPagado = acum;
      } else {
        h.montoPagado = total;
      }
    }
    sincronizarEstadoPagoBoleta(h);
  }

  function productoDeLineaHistorial(linea){
    if (!linea || linea.manual) return null;
    if (linea.id){
      var porId = productos.find(function(p){ return String(p.id) === String(linea.id); });
      if (porId) return porId;
    }
    return productos.find(function(p){ return p.nombre === linea.nombre; }) || null;
  }

  function actualizarPreciosBoletaHistorial(h){
    if (!h || boletaEstaPagada(h)) return { actualizada: false, lineas: 0 };
    var lineasActualizadas = 0;
    var tocada = false;

    (h.lineas || []).forEach(function(l){
      var prod = productoDeLineaHistorial(l);
      if (!prod) return;
      var cambio = false;
      if (!l.id){ l.id = prod.id; cambio = true; }
      if (l.nombre !== prod.nombre){ l.nombre = prod.nombre; cambio = true; }
      if (l.precio !== prod.precio){
        l.precio = prod.precio;
        lineasActualizadas++;
        cambio = true;
      }
      if (cambio) tocada = true;
    });

    if (!tocada) return { actualizada: false, lineas: 0 };

    recalcularTotalesBoletaHistorial(h);
    ajustarPagosBoletaTrasCambioTotal(h);
    return { actualizada: true, lineas: lineasActualizadas };
  }

  window.actualizarPreciosBoleta = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    if (boletaEstaPagada(h)){
      mostrarAviso('Solo se pueden actualizar precios en boletas pendientes');
      return;
    }
    var etiqueta = 'N°' + (h.numero || '—') + (h.cliente ? (' · ' + h.cliente) : '');
    if (!confirm(
      '¿Actualizar los precios del catálogo en la boleta ' + etiqueta + '?\n\n' +
      'Solo cambian productos del catálogo (no ítems manuales). Los abonos ya hechos se mantienen y se recalcula el saldo.'
    )) return;

    var res = actualizarPreciosBoletaHistorial(h);
    if (!res.actualizada){
      mostrarAviso('Esta boleta ya tenía los precios actuales del catálogo');
      return;
    }

    persistirLocalStorage();
    refrescarVistasTrasCambioHistorial();
    mostrarAviso('Precios actualizados en la boleta ' + (h.numero || '—') + ' ✅');
  };

  function refrescarVistasTrasCambioHistorial(){
    actualizarStatHistorial();
    renderHistorial();
    renderClientes();
    if (historialDetalleAbiertoId) verDetalleHistorial(historialDetalleAbiertoId);
    if (clienteDetalleAbiertoId) verDetalleCliente(clienteDetalleAbiertoId);
  }

  function historialDelCliente(nombre){
    var n = normalizarNombreCliente(nombre).toLowerCase();
    if (!n) return [];
    return historial.filter(function(h){
      return normalizarNombreCliente(h.cliente).toLowerCase() === n;
    }).sort(function(a, b){
      var ta = new Date(a.guardadoEn || a.fecha || 0).getTime();
      var tb = new Date(b.guardadoEn || b.fecha || 0).getTime();
      return tb - ta;
    });
  }

  function saldoClientePorNombre(nombre){
    var total = 0;
    historialDelCliente(nombre).forEach(function(h){
      total += saldoPendienteBoleta(h);
    });
    return total;
  }

  function totalCobranzaPendiente(){
    var total = 0;
    var clientesConDeuda = {};
    historial.forEach(function(h){
      var saldo = saldoPendienteBoleta(h);
      if (saldo <= 0.004) return;
      total += saldo;
      var key = normalizarNombreCliente(h.cliente).toLowerCase() || '__sin_nombre__';
      clientesConDeuda[key] = true;
    });
    return { total: total, clientes: Object.keys(clientesConDeuda).length };
  }

  function aplicarPayload(datos){
    if (!datos) return;
    productos = datos.productos || [];
    categorias = Array.isArray(datos.categorias) ? datos.categorias : [];
    contadorBoleta = datos.contadorBoleta || 1;
    contadorBoletaManual = !!datos.contadorBoletaManual;
    historial = Array.isArray(datos.historial) ? datos.historial.map(normalizarBoletaHistorial) : [];
    clientes = Array.isArray(datos.clientes) ? datos.clientes.map(normalizarCliente) : [];
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
      localStorage.setItem('gb_contador_manual', contadorBoletaManual ? '1' : '0');
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
      datos.contadorBoletaManual = localStorage.getItem('gb_contador_manual') === '1';
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

    var nuevo = { id: uid(), nombre: nombre, recordatorios: [] };
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
      if (existente) existente.nombre = nombre;
      cancelarEdicionCliente();
      mostrarAviso('Cliente actualizado ✅');
    } else {
      clientes.push({ id: uid(), nombre: nombre, recordatorios: [] });
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

    var resumenEl = document.getElementById('clientes-cobranza-resumen');
    if (resumenEl){
      var cobranza = totalCobranzaPendiente();
      if (cobranza.total > 0.004){
        resumenEl.innerHTML = '<strong>A cobrar:</strong> ' + money(cobranza.total) +
          ' · <span>' + cobranza.clientes + (cobranza.clientes === 1 ? ' cliente' : ' clientes') + ' con saldo</span>';
        resumenEl.classList.add('show');
      } else {
        resumenEl.innerHTML = 'No hay saldos pendientes de cobro.';
        resumenEl.classList.remove('show');
      }
    }

    if (wrap){
      if (clientes.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:18px 6px;">Todavía no cargaste clientes.<br>Agregá el primero arriba para poder referenciarlo en tus boletas.</div>';
      } else {
        wrap.innerHTML = '<div class="cat-lista">' + clientes.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).map(function(c){
          var saldo = saldoClientePorNombre(c.nombre);
          var notasHtml = htmlNotasCliente(c);
          var saldoHtml = saldo > 0.004
            ? '<div class="cliente-saldo deuda">Debe ' + money(saldo) + '</div>'
            : '<div class="cliente-saldo al-dia">Al día</div>';
          return '<div class="cliente-item-wrap">' +
            '<div class="cat-item cliente-item">' +
            '<div class="cliente-item-head">' +
              '<span class="nombre">' + escapeHtml(c.nombre) + '</span>' +
              '<span class="acciones">' +
                '<button type="button" class="btn-icon" title="Agregar nota" data-action="agregar-nota-cliente" data-id="' + escapeHtml(c.id) + '">📝</button>' +
                '<button type="button" class="btn-icon" title="Historial de compras" data-action="ver-cliente" data-id="' + escapeHtml(c.id) + '">📋</button>' +
                '<button type="button" class="btn-icon" title="Editar nombre" data-action="editar-cliente" data-id="' + escapeHtml(c.id) + '">✏️</button>' +
                '<button type="button" class="btn-icon danger" title="Eliminar" data-action="eliminar-cliente" data-id="' + escapeHtml(c.id) + '">🗑️</button>' +
              '</span>' +
            '</div>' +
            notasHtml +
            saldoHtml +
          '</div>' +
          (clienteNotaAbiertoId === c.id ? htmlFormNotaCliente(c) : '') +
          '</div>';
        }).join('') + '</div>';
      }
    }
    renderClientesDatalist();
  }

  window.verDetalleCliente = function(id){
    var c = clientePorId(id);
    if (!c) return;
    clienteDetalleAbiertoId = id;
    var boletas = historialDelCliente(c.nombre);
    var saldo = saldoClientePorNombre(c.nombre);
    var totalComprado = boletas.reduce(function(acc, h){ return acc + (isFinite(h.total) ? h.total : 0); }, 0);
    var notasHtml = htmlNotasCliente(c, { detalle: true });
    var sinNotas = !(c.recordatorios && c.recordatorios.length);

    var historialHtml = boletas.length === 0
      ? '<div class="empty-state" style="padding:16px 0;">Todavía no hay boletas guardadas para este cliente.</div>'
      : '<div class="cliente-historial-lista">' + boletas.map(function(h){
          var estado = boletaEstaPagada(h) ? 'pagada' : (boletaEsParcial(h) ? 'parcial' : 'pendiente');
          var estadoTxt = boletaEstaPagada(h) ? 'Pagada' : (boletaEsParcial(h) ? ('Parcial · ' + money(saldoPendienteBoleta(h))) : 'Pendiente');
          return '<div class="cliente-historial-item">' +
            '<div><strong>N°' + escapeHtml(h.numero || '—') + '</strong> · ' + formatearFechaLegible(h.fecha) + '</div>' +
            '<div class="cliente-historial-meta">' +
              '<span class="pago-badge ' + estado + '">' + estadoTxt + '</span>' +
              '<span class="mono">' + money(h.total) + '</span>' +
            '</div>' +
            '<div class="cliente-historial-acciones">' +
              '<button type="button" class="btn btn-ghost btn-sm" data-action="ver-historial" data-id="' + escapeHtml(h.id) + '">Ver boleta</button>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';

    var html =
      '<div class="cliente-detalle-head">' +
        '<h3>' + escapeHtml(c.nombre) + '</h3>' +
        '<div class="cliente-detalle-notas-wrap">' +
          '<h4 class="cliente-notas-titulo">Notas / recordatorios</h4>' +
          (sinNotas ? '<p class="cliente-detalle-notas muted">Sin notas todavía.</p>' : notasHtml) +
          htmlFormNotaCliente(c, 'cliente-nota-input-detalle') +
        '</div>' +
      '</div>' +
      '<div class="cliente-detalle-stats">' +
        '<div><span>Total comprado</span><strong class="mono">' + money(totalComprado) + '</strong></div>' +
        '<div><span>Saldo pendiente</span><strong class="mono ' + (saldo > 0.004 ? 'deuda' : 'al-dia') + '">' + money(saldo) + '</strong></div>' +
        '<div><span>Boletas</span><strong>' + boletas.length + '</strong></div>' +
      '</div>' +
      '<h4 class="cliente-historial-titulo">Historial de compras</h4>' +
      historialHtml;

    document.getElementById('cliente-detalle-body').innerHTML = html;
    document.getElementById('cliente-overlay').classList.add('show');
  };

  window.cerrarDetalleCliente = function(){
    clienteDetalleAbiertoId = null;
    document.getElementById('cliente-overlay').classList.remove('show');
  };

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
        existente.nombre = nombre;
        existente.precio = precio;
        existente.codigo = codigo;
        existente.categoriaId = categoriaId;
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
    if (boletaEstaBloqueada()) return;
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
    if (boletaEstaBloqueada()) return;
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
    if (boletaEstaBloqueada()) return;
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
    if (boletaEstaBloqueada()) return;
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
    var bloqueada = boletaEstaBloqueada();

    if (calc.lineas.length === 0){
      cont.innerHTML = '<div class="receipt-empty">Todavía no agregaste productos a esta boleta.</div>';
    } else {
      cont.innerHTML = calc.lineas.map(function(l){
        var quitarBtn = bloqueada ? '' : (l.manual
          ? '<button type="button" class="quitar" title="Quitar" data-action="quitar-manual" data-id="' + escapeHtml(l.id) + '">✕</button>'
          : '<button type="button" class="quitar" title="Quitar" data-action="quitar-producto" data-id="' + escapeHtml(l.id) + '" data-cant="' + l.cantidad + '">✕</button>');
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
    actualizarEstadoBotonesBoletaAccion();
  }
  window.renderResumenBoleta = renderResumenBoleta;
  window.renderListaBoleta = renderListaBoleta;
  window.renderProductos = renderProductos;

  window.nuevaBoleta = function(){
    if (boletaEstaBloqueada()){
      // Boleta ya guardada: pasar a la siguiente sin preguntar
    } else if (!resolverBoletaPendienteAntesDeReemplazar(
      boletaReeditandoId
        ? '¿Guardar los cambios de esta boleta antes de empezar una nueva?'
        : '¿Guardar esta boleta en el historial antes de empezar una nueva?',
      boletaReeditandoId
        ? '¿Empezar una boleta nueva sin guardar los cambios? Se perderá la edición.'
        : '¿Empezar una boleta nueva sin guardar? Se perderá la boleta actual.'
    )) return;
    if (!hayBoletaPendiente() && !boletaReeditandoId && !boletaEstaBloqueada()){
      mostrarAviso('Boleta nueva lista 🧾');
      return;
    }
    var eraReedicion = !!boletaReeditandoId;
    var yaGuardadaBloqueada = boletaEstaBloqueada();
    ocultarBannerBoletaReeditando();
    if (!eraReedicion && !yaGuardadaBloqueada) contadorBoleta += 1;
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
    if (!validarBoletaGuardadaParaAccion()) return;
    imprimirBoletaHistorial(boletaGuardadaActivaId);
    boletaImpresa = true;
  };

  window.imprimirBoletaHistorial = function(id){
    var h = buscarEnHistorial(id);
    if (!h) return;
    var datos = datosBoletaDesdeHistorial(h);
    var doble = document.getElementById('print-doble');
    if (!doble) return;
    doble.innerHTML =
      construirReceiptEstatico(datos, 'Copia comercio') +
      construirReceiptEstatico(datos, 'Copia cliente');
    window.print();
    mostrarAviso('Comprobante listo para imprimir 🖨️');
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
    if (!validarBoletaGuardadaParaAccion()) return;
    var h = buscarEnHistorial(boletaGuardadaActivaId);
    if (!h) return;
    abrirWhatsappConTexto(textoBoletaParaWhatsapp(datosBoletaDesdeHistorial(h)));
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

    if (boletaReeditandoId){
      var idx = historial.findIndex(function(x){ return x.id === boletaReeditandoId; });
      if (idx !== -1){
        var anterior = historial[idx];
        var actualizado = {
          id: anterior.id,
          numero: anterior.numero,
          fecha: anterior.fecha,
          guardadoEn: anterior.guardadoEn,
          recordatorioSemana: anterior.recordatorioSemana,
          cliente: cliente,
          negocio: document.getElementById('b-negocio').value || '',
          lineas: calc.lineas,
          subtotal: calc.subtotal,
          descuentoMonto: calc.descuentoMonto,
          total: calc.total
        };
        if (pagada){
          actualizado.abonos = Array.isArray(anterior.abonos) ? anterior.abonos.slice() : [];
          var saldo = saldoPendienteBoleta(anterior);
          if (saldo > 0.004){
            actualizado.abonos.push({
              id: uid(),
              monto: saldo,
              fecha: hoyISO(),
              registradoEn: new Date().toISOString()
            });
          }
          actualizado.montoPagado = calc.total;
          actualizado.pagadaEn = anterior.pagadaEn || new Date().toISOString();
        } else if (boletaEstaPagada(anterior)){
          actualizado.montoPagado = 0;
          actualizado.abonos = [];
          delete actualizado.pagadaEn;
        } else {
          actualizado.abonos = Array.isArray(anterior.abonos) ? anterior.abonos.slice() : [];
          actualizado.montoPagado = montoPagadoBoleta(anterior);
        }
        sincronizarEstadoPagoBoleta(actualizado);
        if (!boletaEstaPagada(actualizado)) ajustarPagosBoletaTrasCambioTotal(actualizado);
        historial[idx] = normalizarBoletaHistorial(actualizado);
        ocultarBannerBoletaReeditando();
        marcarBoletaGuardada(actualizado.id);
        persistirLocalStorage();
        actualizarStatHistorial();
        renderHistorial();
        renderClientes();
        if (!opciones.silencioso){
          if (eraNuevo){
            mostrarAviso('Boleta N° ' + (actualizado.numero || '—') + ' actualizada ✅');
          } else if (boletaEstaPagada(actualizado)){
            mostrarAviso('Boleta N° ' + (actualizado.numero || '—') + ' actualizada y archivada ✅');
          } else {
            mostrarAviso('Boleta N° ' + (actualizado.numero || '—') + ' guardada ✅ · Imprimí, compartí o Nueva Boleta');
          }
        }
        return true;
      }
      ocultarBannerBoletaReeditando();
    }

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
      montoPagado: pagada ? calc.total : 0,
      guardadoEn: new Date().toISOString()
    };
    if (pagada) registro.pagadaEn = registro.guardadoEn;
    sincronizarEstadoPagoBoleta(registro);
    historial.unshift(registro);
    contadorBoleta += 1;
    marcarBoletaGuardada(registro.id);
    persistirLocalStorage();
    actualizarStatHistorial();
    renderHistorial();
    renderClientes();
    if (!opciones.silencioso){
      if (eraNuevo){
        mostrarAviso('Boleta guardada · «' + cliente + '» agregado a clientes ✅ · Imprimí, compartí o Nueva Boleta');
      } else if (boletaEstaPagada(registro)){
        mostrarAviso('Boleta guardada como pagada y archivada ✅');
      } else {
        mostrarAviso('Boleta guardada ✅ · Imprimí, compartí o empezá otra con «Nueva Boleta»');
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
      var pendientes = historial.filter(function(h){ return !boletaEstaPagada(h); }).length;
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
    var pagada = boletaEstaPagada(h);
    var idAttr = inputId ? ' id="' + inputId + '"' : '';
    return '<label class="pago-check" title="' + (pagada ? 'Desmarcar pago' : 'Marcar como pagada') + '">' +
      '<input type="checkbox" data-action="toggle-pago-historial" data-id="' + escapeHtml(h.id) + '"' + idAttr + (pagada ? ' checked' : '') + '>' +
      '<span>' + etiquetaPagoBoleta(h) + '</span>' +
    '</label>';
  }

  function htmlListaAbonosBoleta(h){
    if (!h.abonos || h.abonos.length === 0) return '';
    var items = h.abonos.slice().sort(function(a, b){
      return String(a.fecha || '').localeCompare(String(b.fecha || ''));
    }).map(function(a){
      return '<li class="pago-abono-item">' +
        '<span class="pago-abono-monto mono">' + money(a.monto) + '</span>' +
        '<span class="pago-abono-fecha">' + formatearFechaLegible(a.fecha) + '</span>' +
      '</li>';
    }).join('');
    return '<div class="pago-abonos-lista">' +
      '<div class="pago-abonos-titulo">Abonos registrados</div>' +
      '<ul class="pago-abonos-items">' + items + '</ul>' +
    '</div>';
  }

  function htmlPagoParcialDetalle(h){
    if (boletaEstaPagada(h)) return htmlListaAbonosBoleta(h);
    var saldo = saldoPendienteBoleta(h);
    var pagado = montoPagadoBoleta(h);
    return '<div class="pago-parcial-box">' +
      '<div class="pago-parcial-titulo">Pago parcial</div>' +
      '<div class="pago-parcial-resumen">' +
        '<div class="pago-parcial-stat"><span>Pagado</span><strong class="mono">' + money(pagado) + '</strong></div>' +
        '<div class="pago-parcial-stat deuda"><span>Saldo</span><strong class="mono">' + money(saldo) + '</strong></div>' +
      '</div>' +
      htmlListaAbonosBoleta(h) +
      '<div class="pago-parcial-form">' +
        '<div class="pago-parcial-form-campos">' +
          '<div class="pago-parcial-field">' +
            '<label for="historial-abono-fecha">Fecha del abono</label>' +
            '<input type="date" id="historial-abono-fecha" value="' + hoyISO() + '" aria-label="Fecha del abono">' +
          '</div>' +
          '<div class="pago-parcial-field pago-parcial-field-monto">' +
            '<label for="historial-abono-input">Monto del abono</label>' +
            '<input type="number" id="historial-abono-input" class="mono" min="0.01" step="0.01" max="' + saldo + '" placeholder="Ej: 5000" aria-label="Monto del abono">' +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-primary pago-parcial-btn" data-action="registrar-abono" data-id="' + escapeHtml(h.id) + '">Pago parcial</button>' +
      '</div>' +
      '<p class="pago-parcial-nota">La boleta sigue pendiente hasta saldar el total o marcarla como pagada.</p>' +
    '</div>';
  }

  function renderHistorialItem(h){
    var clienteHtml = h.cliente ? escapeHtml(h.cliente) : '<span class="anon">Sin nombre de cliente</span>';
    var cantItems = h.lineas.reduce(function(acc, l){ return acc + l.cantidad; }, 0);
    var pagada = boletaEstaPagada(h);
    var parcial = boletaEsParcial(h);
    var badgeClass = pagada ? 'pagada' : (parcial ? 'parcial' : 'pendiente');
    var badgeTxt = pagada ? 'Archivada' : (parcial ? 'Pago parcial' : 'Cobro pendiente');
    var montoHtml = parcial
      ? '<span class="saldo-parcial">' + money(saldoPendienteBoleta(h)) + '<small> de ' + money(h.total) + '</small></span>'
      : money(h.total);
    return '<div class="historial-item' + (pagada ? ' archivada' : '') + '">' +
      htmlPagoBoleta(h) +
      '<div class="num-badge">N°' + escapeHtml(h.numero || '—') + '</div>' +
      '<div class="info">' +
        '<div class="cliente">' + clienteHtml + '</div>' +
        '<div class="meta">' +
          '<span>📅 ' + formatearFechaLegible(h.fecha) + '</span>' +
          '<span>🧺 ' + cantItems + (cantItems === 1 ? ' ítem' : ' ítems') + '</span>' +
          '<span class="pago-badge ' + badgeClass + '">' + badgeTxt + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="monto mono">' + montoHtml + '</div>' +
      '<div class="acciones">' +
        (pagada ? '' : '<button type="button" class="btn-icon" title="Actualizar precios del catálogo" data-action="actualizar-precios-boleta" data-id="' + escapeHtml(h.id) + '">💲</button>') +
        (pagada ? '' : '<button type="button" class="btn-icon" title="Pago parcial" data-action="pago-parcial-historial" data-id="' + escapeHtml(h.id) + '">💵</button>') +
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

    var activas = historial.filter(function(h){ return !boletaEstaPagada(h) && historialCoincideBusqueda(h, query); });
    var archivadas = historial.filter(function(h){ return boletaEstaPagada(h) && historialCoincideBusqueda(h, query); });

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
    if (boletaEstaPagada(h)) return false;
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
      mapa[key].total += saldoPendienteBoleta(h);
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
      if (!boletaEstaPagada(h)) return false;
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
    recalcularContadorBoletaTrasEliminar();
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
    if (pagada){
      var saldo = saldoPendienteBoleta(h);
      if (saldo > 0.004){
        if (!Array.isArray(h.abonos)) h.abonos = [];
        h.abonos.push({
          id: uid(),
          monto: saldo,
          fecha: hoyISO(),
          registradoEn: new Date().toISOString()
        });
      }
      h.montoPagado = h.total || 0;
      h.pagadaEn = new Date().toISOString();
    } else {
      h.montoPagado = 0;
      h.abonos = [];
      delete h.pagadaEn;
    }
    sincronizarEstadoPagoBoleta(h);
    persistirLocalStorage();
    renderHistorial();
    renderClientes();
    if (historialDetalleAbiertoId === id) verDetalleHistorial(id);
    if (clienteDetalleAbiertoId) verDetalleCliente(clienteDetalleAbiertoId);
    mostrarAviso(boletaEstaPagada(h) ? 'Boleta pagada y archivada ✅' : 'Pago pendiente · boleta activa');
  };

  window.registrarAbonoBoleta = function(id, monto, fecha){
    var h = buscarEnHistorial(id);
    if (!h) return;
    monto = parseFloat(monto);
    if (isNaN(monto) || monto <= 0){
      mostrarAviso('Ingresá un monto de abono válido');
      return;
    }
    var saldo = saldoPendienteBoleta(h);
    if (monto > saldo + 0.004){
      mostrarAviso('El abono no puede superar el saldo (' + money(saldo) + ')');
      return;
    }
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = hoyISO();
    if (!Array.isArray(h.abonos)) h.abonos = [];
    h.abonos.push({
      id: uid(),
      monto: monto,
      fecha: fecha,
      registradoEn: new Date().toISOString()
    });
    h.montoPagado = montoPagadoBoleta(h) + monto;
    if (boletaEstaPagada(h)) h.pagadaEn = new Date().toISOString();
    sincronizarEstadoPagoBoleta(h);
    persistirLocalStorage();
    renderHistorial();
    renderClientes();
    if (historialDetalleAbiertoId === id) verDetalleHistorial(id);
    if (clienteDetalleAbiertoId) verDetalleCliente(clienteDetalleAbiertoId);
    mostrarAviso(boletaEstaPagada(h)
      ? 'Boleta saldada ✅'
      : ('Pago parcial registrado · saldo ' + money(saldoPendienteBoleta(h))));
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
    if (boletaReeditandoId === id){
      ocultarBannerBoletaReeditando();
      limpiarBoletaActual();
      actualizarNumeroBoleta();
    }
    if (boletaGuardadaActivaId === id) limpiarBoletaGuardada();
    historial = historial.filter(function(x){ return x.id !== id; });
    recalcularContadorBoletaTrasEliminar();
    persistirLocalStorage();
    renderHistorial();
    renderClientes();
    mostrarAviso('Boleta eliminada · próximo N° ' + String(contadorBoleta).padStart(4, '0'));
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
        htmlPagoParcialDetalle(h) +
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
    var btnActualizarPreciosDetalle = document.getElementById('historial-detalle-actualizar-precios-btn');
    if (btnActualizarPreciosDetalle){
      btnActualizarPreciosDetalle.style.display = boletaEstaPagada(h) ? 'none' : '';
    }
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
      boletaReeditandoId
        ? '¿Guardar los cambios de la boleta actual antes de abrir otra del historial?'
        : '¿Guardar la boleta actual en el historial antes de abrir otra?',
      boletaReeditandoId
        ? '¿Abrir otra boleta sin guardar los cambios? Se perderá la edición actual.'
        : '¿Abrir la boleta del historial sin guardar la actual? Se perderá la boleta actual.'
    )) return;

    cantidades = {};
    itemsManuales = [];
    h.lineas.forEach(function(l){
      if (l.manual){
        itemsManuales.push({ id: l.id || uid(), nombre: l.nombre, precio: l.precio, cantidad: l.cantidad });
        return;
      }
      var prod = null;
      if (l.id){
        prod = productos.find(function(p){ return String(p.id) === String(l.id); });
      }
      if (!prod){
        prod = productos.find(function(p){ return p.nombre === l.nombre && p.precio === l.precio; });
      }
      if (prod){
        cantidades[prod.id] = (cantidades[prod.id] || 0) + l.cantidad;
      } else {
        itemsManuales.push({ id: l.id || uid(), nombre: l.nombre, precio: l.precio, cantidad: l.cantidad });
      }
    });

    document.getElementById('b-numero').value = h.numero || '';
    document.getElementById('b-fecha').value = h.fecha || hoyISO();
    document.getElementById('b-cliente').value = h.cliente || '';
    if (h.negocio) document.getElementById('b-negocio').value = h.negocio;
    validarClienteBoleta(false);
    document.getElementById('b-descuento').value = h.descuentoMonto || 0;
    document.getElementById('b-descuento-tipo').value = 'monto';
    var pagadaEl = document.getElementById('b-pagada');
    if (pagadaEl) pagadaEl.checked = boletaEstaPagada(h);
    resetearFlagsBoletaSesion();
    mostrarBannerBoletaReeditando(h);

    cerrarDetalleHistorial();
    cambiarTab('boleta');
    renderListaBoleta();
    renderResumenBoleta();
    mostrarAviso('Boleta N° ' + (h.numero || '—') + ' abierta para editar 🧾');
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
    var btnCancelarReedicionBoleta = document.getElementById('btn-cancelar-reedicion-boleta');
    if (btnCancelarReedicionBoleta) btnCancelarReedicionBoleta.addEventListener('click', cancelarReedicionBoleta);
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

    var btnCerrarCliente = document.getElementById('btn-cerrar-cliente');
    var overlayCliente = document.getElementById('cliente-overlay');
    if (btnCerrarCliente) btnCerrarCliente.addEventListener('click', cerrarDetalleCliente);
    if (overlayCliente){
      overlayCliente.addEventListener('click', function(ev){
        if (ev.target === overlayCliente) cerrarDetalleCliente();
      });
    }

    var btnWppDetalle = document.getElementById('historial-detalle-wpp-btn');
    var btnImprimirDetalle = document.getElementById('historial-detalle-imprimir-btn');
    var btnReabrirDetalle = document.getElementById('historial-detalle-reabrir-btn');
    var btnEliminarDetalle = document.getElementById('historial-detalle-eliminar-btn');
    var btnActualizarPreciosDetalle = document.getElementById('historial-detalle-actualizar-precios-btn');
    if (btnWppDetalle){
      btnWppDetalle.addEventListener('click', function(){
        if (historialDetalleAbiertoId) compartirDesdeHistorial(historialDetalleAbiertoId);
      });
    }
    if (btnImprimirDetalle){
      btnImprimirDetalle.addEventListener('click', function(){
        if (historialDetalleAbiertoId) imprimirBoletaHistorial(historialDetalleAbiertoId);
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
    if (btnActualizarPreciosDetalle){
      btnActualizarPreciosDetalle.addEventListener('click', function(){
        if (historialDetalleAbiertoId) actualizarPreciosBoleta(historialDetalleAbiertoId);
      });
    }

    var buscador = document.getElementById('buscador');
    var buscadorCatalogo = document.getElementById('buscador-catalogo');
    var buscadorHistorial = document.getElementById('buscador-historial');
    if (buscador) buscador.addEventListener('input', renderListaBoleta);
    if (buscadorCatalogo) buscadorCatalogo.addEventListener('input', renderProductos);
    if (buscadorHistorial) buscadorHistorial.addEventListener('input', renderHistorial);

    document.body.addEventListener('keydown', function(ev){
      if (ev.key !== 'Enter') return;
      var guardarBtn = ev.target.closest('[data-action="guardar-nota-cliente"]');
      if (guardarBtn){
        ev.preventDefault();
        guardarNotaClienteDesdeForm(guardarBtn.getAttribute('data-id') || '', guardarBtn.getAttribute('data-input-id') || '');
        return;
      }
      if (ev.target.classList && ev.target.classList.contains('cliente-nota-input')){
        var form = ev.target.closest('.cliente-nota-form');
        if (!form) return;
        var btn = form.querySelector('[data-action="guardar-nota-cliente"]');
        if (!btn) return;
        ev.preventDefault();
        guardarNotaClienteDesdeForm(btn.getAttribute('data-id') || '', btn.getAttribute('data-input-id') || '');
      }
    });

    var bNegocio = document.getElementById('b-negocio');
    var bCliente = document.getElementById('b-cliente');
    var bDescuento = document.getElementById('b-descuento');
    var bDescuentoTipo = document.getElementById('b-descuento-tipo');
    if (bNegocio) bNegocio.addEventListener('input', guardarNegocio);
    if (bCliente){
      bCliente.addEventListener('input', function(){
        validarClienteBoleta(false);
        actualizarEstadoBotonesBoletaAccion();
      });
      bCliente.addEventListener('change', function(){
        normalizarClienteBoleta();
        actualizarEstadoBotonesBoletaAccion();
      });
      bCliente.addEventListener('blur', normalizarClienteBoleta);
    }
    if (bDescuento) bDescuento.addEventListener('input', renderResumenBoleta);
    if (bDescuentoTipo) bDescuentoTipo.addEventListener('change', renderResumenBoleta);
    var bPagada = document.getElementById('b-pagada');
    if (bPagada) bPagada.addEventListener('change', actualizarEstadoBotonesBoletaAccion);

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
        case 'ver-cliente': verDetalleCliente(id); break;
        case 'agregar-nota-cliente': abrirFormNotaCliente(id); break;
        case 'guardar-nota-cliente': guardarNotaClienteDesdeForm(id, btn.getAttribute('data-input-id') || ''); break;
        case 'cancelar-nota-cliente': cancelarFormNotaCliente(); break;
        case 'eliminar-nota-cliente': eliminarNotaCliente(id, btn.getAttribute('data-nota-id') || ''); break;
        case 'registrar-abono': {
          var inputAbono = document.getElementById('historial-abono-input');
          var inputFecha = document.getElementById('historial-abono-fecha');
          registrarAbonoBoleta(
            id,
            inputAbono ? inputAbono.value : 0,
            inputFecha ? inputFecha.value : ''
          );
          break;
        }
        case 'pago-parcial-historial': verDetalleHistorial(id); break;
        case 'actualizar-precios-boleta': actualizarPreciosBoleta(id); break;
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
      if (!hayBoletaSinGuardar()) return;
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