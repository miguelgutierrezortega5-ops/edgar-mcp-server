# WLED-8CH-WT32 — Controlador de 8 salidas para tiras LED direccionables

Placa de 2 capas, 100 % through-hole (soldadura a mano), basada en el módulo
**WT32-ETH01** (ESP32 + LAN8720, Ethernet 10/100), con un **74HCT245** como
elevador de nivel 3,3 V → 5 V y 8 salidas con fusible mini blade individual.

| Parámetro | Valor |
|---|---|
| Tensión de entrada (= tensión de las tiras) | 5 V, 12 V o 24 V (ver JP1) |
| Salidas | 8 × bornera 3 vías 5,08 mm: DATA · V+ · GND |
| Protección por salida | Fusible mini blade (ATM/APM) en V+, valor según tira (máx. 10 A) |
| Corriente total recomendada | ≤ 30 A (ver §5) |
| Tipo de LED | Cualquiera de 1 hilo: WS2812B, WS2811, SK6812, WS2815, etc. |
| Firmware | WLED build ESP32 con Ethernet, placa "WT32-ETH01" |
| Tamaño orientativo | 160 × 100 mm, 2 capas, cobre 2 oz (70 µm) |

---

## 1. Diagrama de bloques

```
 VIN (5–24 V) ──┬── C1 1000µF ──────────────────── BUS_V+ (pour ancho) ──┬─ F1 ─ J1.V+
  J_IN (2 vías)  │                                                        ├─ F2 ─ J2.V+
                 │                                                        │  ...
                 │                                                        └─ F8 ─ J8.V+
                 │
                 └─ F0 (PTC 0,5 A) ─ VIN_F ─┬─ D1 1N5819 ─ U2 R-78E5.0 ─ REG_5V ─┐
                                            │                                    JP1 ── +5V ──┬─ WT32 5V
                                            └────────────────────────────────────┘            ├─ U1 74HCT245 VCC
                                                                                               └─ D2 P6KE6.8A (clamp)
   WT32-ETH01 (3,3 V)            74HCT245 (5 V)
   IO4  ─┬─────────────────────── A1  B1 ── R1 33Ω ── J1.DATA
   IO2  ─┤                        A2  B2 ── R2 33Ω ── J2.DATA
   IO12 ─┤  RN1 10k a GND         A3  B3 ── R3 33Ω ── J3.DATA
   IO14 ─┤  (pull-down de         A4  B4 ── R4 33Ω ── J4.DATA
   IO15 ─┤   arranque)            A5  B5 ── R5 33Ω ── J5.DATA
   IO32 ─┤                        A6  B6 ── R6 33Ω ── J6.DATA
   IO33 ─┤                        A7  B7 ── R7 33Ω ── J7.DATA
   IO5  ─┘                        A8  B8 ── R8 33Ω ── J8.DATA
                                  DIR=+5V (A→B), /OE=GND
```

## 2. Asignación de GPIO (WT32-ETH01)

El Ethernet del WT32-ETH01 ocupa IO0 (reloj 50 MHz), IO16 (enable del
oscilador), IO18/IO23 (MDIO/MDC) e IO19/21/22/25/26/27 (RMII): **no tocar**.

| Salida | GPIO | Rótulo en el módulo | 74HCT245 (A → B) | Nota |
|---|---|---|---|---|
| CH1 | IO4  | IO4    | pin 2 → pin 18 | |
| CH2 | IO2  | IO2    | pin 3 → pin 17 | Strapping: debe estar bajo/flotante en flasheo → pull-down OK |
| CH3 | IO12 | IO12   | pin 4 → pin 16 | **Strapping crítico**: alto en el arranque = flash a 1,8 V = no arranca. El pull-down de RN1 lo resuelve |
| CH4 | IO14 | IO14   | pin 5 → pin 15 | |
| CH5 | IO15 | IO15   | pin 6 → pin 14 | Strapping: bajo solo silencia el log de arranque (inofensivo) |
| CH6 | IO32 | CFG    | pin 7 → pin 13 | |
| CH7 | IO33 | 485_EN | pin 8 → pin 12 | |
| CH8 | IO5  | RXD    | pin 9 → pin 11 | Strapping SDIO, irrelevante aquí |
| Botón | IO39 | IO39  | — | Solo entrada, sin pull-up interno → R11 10k a 3V3 |
| Aux | IO17, IO35, IO36 | TXD, IO35, IO36 | — | Libres en J_AUX (IO35/36 solo entrada) |

Los 8 pull-downs (RN1, red SIP-9 de 10 kΩ con común) mantienen las entradas del
'245 en nivel bajo durante el arranque, evitando parpadeos en las tiras y
garantizando el strapping de IO12.

## 3. Netlist completo

### Alimentación
| Net | Conexiones |
|---|---|
| VIN | J_IN.1, C1(+), F0.1, F1..F8 (lado entrada, vía BUS_V+) |
| GND | J_IN.2, C1(−), C2(−), C3(−), C4, C5, C6, C7, U2.2, U1.10, U1.19, D2 (ánodo), RN1.1 (común), SW1.2, J_PROG.1, J_AUX.2, WT32 GND (todos), Jn.GND (×8), LED1 vía R10 |
| VIN_F | F0.2, D1 ánodo, JP1.3 |
| VIN_D | D1 cátodo, U2.1 (Vin R-78), C2(+) 10 µF/50 V |
| REG_5V | U2.3 (Vout), C3(+) 22 µF/16 V, JP1.1 |
| +5V | JP1.2, WT32 5V, U1.20 (VCC), U1.1 (DIR), C4 100 µF/10 V (+), C5 100 nF (junto a U1), D2 cátodo, R10 → LED1 |
| +3V3 | WT32 3V3 (salida del LDO del módulo), R11, J_AUX.1, C7 100 nF |

### Selector JP1 (cabezal 1×3 + puente)
| Posición | Uso |
|---|---|
| **1-2 (REG)** | Entrada **12 V o 24 V** (rango del R-78E5.0: 7–28 V) |
| **2-3 (BYPASS)** | Entrada **5 V** (el VIN alimenta directamente la lógica) |

> ⚠️ Si se deja en 2-3 con 12/24 V, D2 (P6KE6.8A) entra en conducción y el PTC F0
> se dispara: la lógica queda protegida, pero **comprueba JP1 antes de conectar**.
> Serigrafía muy visible junto a JP1: `5V: 2-3 | 12/24V: 1-2`.

### Señal (por canal n = 1..8)
| Net | Conexiones |
|---|---|
| GPIO_n | WT32 IOx (tabla §2), U1 pin An, RN1 pin n+1 |
| DOUT_n | U1 pin Bn, Rn.1 |
| DATA_n | Rn.2 (33 Ω), Jn.1 |
| VOUT_n | Fn salida, Jn.2 |
| GND | Jn.3 |

Patillaje 74HCT245 (DIP-20): 1 DIR · 2–9 A1–A8 · 10 GND · 11 B8 … 18 B1 · 19 /OE · 20 VCC.

### Varios
| Net | Conexiones |
|---|---|
| BTN | WT32 IO39, R11 (10k a +3V3), C6 100 nF a GND, SW1.1 |
| J_PROG (1×5) | 1 GND · 2 TX0 (IO1) · 3 RX0 (IO3) · 4 IO0 · 5 EN |
| J_AUX (1×5) | 1 +3V3 · 2 GND · 3 IO17 · 4 IO35 · 5 IO36 |
| LED1 | +5V → R10 1k → LED1 → GND (piloto de alimentación lógica) |

Para flashear: adaptador USB-serie a 3,3 V en J_PROG, puente IO0–GND, pulsar
EN a GND (o reconectar), soltar. **No alimentes la placa desde el adaptador**;
usa la entrada VIN normal.

## 4. Lista de materiales

Ver [`BOM.csv`](BOM.csv). Resumen: 1 WT32-ETH01, 1 74HCT245N (DIP-20 + zócalo),
1 R-78E5.0-1.0, 8 portafusibles mini blade TH, 9 borneras, 1 red SIP-9 10k,
resistencias de 1/4 W, condensadores radiales, PTC, 1N5819, P6KE6.8A, cabezales.

## 5. Diseño del PCB — reglas de layout

**Disposición sugerida (160 × 100 mm):**
- Borde largo inferior: las 8 borneras J1–J8 (paso entre canales ~19 mm),
  numeradas en serigrafía, con orden **DATA · V+ · GND** impreso al lado.
- Fila de 8 portafusibles justo detrás de las borneras.
- Borde corto izquierdo: J_IN (bornera de alta corriente) + C1, alimentando un
  bus de cobre a lo largo de la fila de fusibles.
- Lado derecho/superior: WT32-ETH01 con el **RJ45 asomando al borde** y la
  antena PCB del módulo sin cobre debajo (ni pistas ni plano) ni cerca.
- 74HCT245 entre el WT32 y las borneras; R1–R8 junto a las salidas B del '245.

**Corriente (cobre 2 oz, ΔT ≈ 20 °C, IPC-2221 capa externa):**

| Corriente | Ancho mínimo |
|---|---|
| 0,5 A (lógica) | 0,5 mm |
| 10 A (V+ y GND por canal) | ≥ 3 mm, mejor pour |
| 30 A (bus VIN / retorno GND) | ≥ 11 mm, pour en ambas caras cosido con vías, o bus soldado con hilo de cobre de 2,5 mm² sobre pista con máscara retirada |

- GND como plano en la cara inferior; retornos de potencia de cada canal
  directos a J_IN sin pasar por debajo del WT32 / '245.
- Señales DATA cortas, con su retorno GND adyacente. Las de 3,3 V (WT32 → '245)
  lejos del bus de potencia.
- Pads de borneras y portafusibles con anillo generoso (≥ 0,6 mm) y sin
  thermal relief estrecho en las conexiones de potencia (o radios anchos).
- Orificios de montaje M3 en las 4 esquinas.

**Corriente total:** el límite real lo marca J_IN y el bus de cobre, no la suma
de fusibles. Diseña para ≤ 30 A; para más, alimenta grupos de canales con
inyecciones separadas o añade una segunda J_IN.

## 6. Elección de fusibles por salida

Fusible ≈ 1,25 × consumo máximo real de la tira, sin pasar de lo que soporta el
cable que sale de la bornera.

| Tira (ejemplo) | Consumo típico a blanco 100 % | Fusible |
|---|---|---|
| 5 V, 150 × WS2812B (60 mA/LED) | 9 A | 10 A (y limitar brillo en WLED) |
| 12 V, 5 m WS2811 (300 LED, 100 IC) | ~3,6 A | 5 A |
| 24 V, 5 m WS2814/SK6812 RGBW | ~3–5 A | 5–7,5 A |

Configura además en WLED el **limitador de corriente** (Brightness limiter) por
salida con un valor por debajo del fusible.

## 7. Configuración WLED

1. Flashea una build ESP32 con Ethernet (en install.wled.me: "ESP32 Ethernet").
2. *Config → WiFi Setup → Ethernet type*: **WT32-ETH01**. Reinicia.
3. *Config → LED Preferences*: crea 8 salidas con los GPIO de §2 en orden
   (4, 2, 12, 14, 15, 32, 33, 5), tipo de LED y número de píxeles.
4. Botón: GPIO 39, tipo "Pushbutton".
5. Activa "Automatic brightness limiter" con la corriente de tu fuente.

## 8. Notas y limitaciones

- **5 V de entrada**: la lógica toma VIN directo; si tu fuente de 5 V baja de
  4,5 V bajo carga, el '245 queda fuera de especificación. Usa una fuente con
  ajuste fino y cable grueso.
- **Entre 5,5 y 7 V** no hay modo válido (fuera de bypass y por debajo del R-78).
- **Polaridad inversa**: D1 protege la rama regulada y D2+F0 la rama bypass,
  pero C1 y las tiras **no** están protegidas. Bornera J_IN con serigrafía
  `+` / `−` grande.
- El WT32-ETH01 tiene variantes con distinta longitud de cabezal y separación
  entre filas: **mide tu módulo** (o usa la huella de su hoja de datos) antes de
  enviar a fabricar. Monta el módulo en zócalos hembra de 2,54 mm.
- Tiras de 12/24 V tipo WS2815 (doble línea de datos): usa solo DATA; deja BI
  sin conectar o a GND según el fabricante.
- Para cables de datos largos (> 3–5 m) añade un repetidor/ transceptor
  diferencial en vez de subir la resistencia serie.
