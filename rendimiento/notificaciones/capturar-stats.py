#!/usr/bin/env python3
"""Captura docker stats cada 2 segundos a CSV. Ejecutar durante las corridas k6."""
import csv,datetime,json,subprocess,sys,time
from pathlib import Path
out=Path(sys.argv[1] if len(sys.argv)>1 else 'rendimiento/notificaciones/results/docker-stats.csv')
out.parent.mkdir(parents=True,exist_ok=True)
with out.open('w',newline='',encoding='utf8') as f:
    writer=csv.writer(f)
    writer.writerow(['timestamp_utc','name','cpu_percent','mem_usage','net_io'])
    try:
        while True:
            proc=subprocess.run(['docker','stats','--no-stream','--format','{{json .}}'],capture_output=True,text=True,check=True)
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            for line in proc.stdout.splitlines():
                row=json.loads(line)
                writer.writerow([now,row.get('Name',''),row.get('CPUPerc',''),row.get('MemUsage',''),row.get('NetIO','')])
            f.flush();time.sleep(2)
    except KeyboardInterrupt:
        print('Datos guardados en',out)
