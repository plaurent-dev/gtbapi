from IPython.display import clear_output
from pymodbus.client.sync import ModbusTcpClient
import paho.mqtt.client as mqtt
import time
import json
import struct
import socket

# -----------------------------
#  GELF
# -----------------------------

def send_gelf(message: dict, host="10.107.1.115", port=12201):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    gelf = {
        "version": "1.1",
        "host": "modbus-reader",
        "short_message": "Modbus measurement",
        "level": 6,
    }

    # Ajout des champs personnalisés Graylog (doivent commencer par _)
    for k, v in message.items():
        gelf[f"_{k}"] = v

    payload = json.dumps(gelf).encode("utf-8")
    sock.sendto(payload, (host, port))


# -----------------------------
#  DECODAGES
# -----------------------------

def decode_whole_seconds(raw_value):
    return raw_value // 256

def decode_year(raw_year):
    high = (raw_year >> 8) & 0xFF
    tens = (high >> 4) & 0x0F
    ones = high & 0x0F
    yy = tens * 10 + ones
    return 2000 + yy

def decode_day_month(raw_decimal):
    raw = int(raw_decimal)
    high = (raw >> 8) & 0xFF
    low  = raw & 0xFF

    def decode_byte(b):
        tens = (b >> 4) & 0x0F
        ones = b & 0x0F
        return tens * 10 + ones

    return decode_byte(high), decode_byte(low)

def decode_float32(reg_high, reg_low):
    raw = (reg_high << 16) | reg_low
    return struct.unpack('>f', raw.to_bytes(4, byteorder='big'))[0]

def decode_seconds_minutes(raw_decimal):
    raw = int(raw_decimal)
    high = (raw >> 8) & 0xFF
    low  = raw & 0xFF

    def decode_byte(b):
        tens = (b >> 4) & 0x0F
        ones = b & 0x0F
        return tens * 10 + ones

    seconds = decode_byte(high)
    minutes = decode_byte(low)

    return seconds, minutes
    


# -----------------------------
#  CONFIG MODBUS
# -----------------------------

modbus = ModbusTcpClient("10.107.31.3", port=4196)
unit_id = 91

# Registres : adresse → {nom, count}
registers = {
    0x00: {"name": "serial_number",   "count": 1},
    0x16: {"name": "intensity",       "count": 2},  # FLOAT32
    0x3C: {"name": "seconds_minutes", "count": 1},
    0x3D: {"name": "days_weeks",      "count": 1},
    0x3E: {"name": "date_month",      "count": 1},
    0x3F: {"name": "year",            "count": 1}
}


# -----------------------------
#  CONFIG MQTT
# -----------------------------

mqtt_client = mqtt.Client()
mqtt_client.connect("10.107.1.123", 1884, 60)
mqtt_client.loop_start()

# -----------------------------
#  BOUCLE PRINCIPALE
# -----------------------------

with modbus:
    while True:
        clear_output(wait=True)

        payload = {}

        for addr, info in registers.items():
            name = info["name"]
            count = info["count"]

            rr = modbus.read_holding_registers(address=addr, count=count, unit=unit_id)

            if rr.isError():
                print(f"Erreur Modbus sur {hex(addr)} :", rr)
                payload[name] = None
                continue

            # -----------------------------
            #  FLOAT32 (2 registres)
            # -----------------------------
            if count == 2:
                reg_high, reg_low = rr.registers
                value = decode_float32(reg_high, reg_low)
                print(f"{name} ({hex(addr)}) -> {value} (float32)")
                payload[name] = value
                continue

            # -----------------------------
            #  REGISTRE SIMPLE (1 mot)
            # -----------------------------
            value = rr.registers[0]
            print(f"{name} ({hex(addr)}) -> {value}")

            if addr == 0x3C:
                value = decode_seconds_minutes(value)

            if addr == 0x3F:
                value = decode_year(value)

            if addr in (0x3E, 0x3D):
                value = decode_day_month(value)

            payload[name] = value

        # Envoi MQTT
        mqtt_client.publish("modbus/mesures", json.dumps(payload))
        # Envoi Graylog 
        send_gelf(payload)
        time.sleep(5)