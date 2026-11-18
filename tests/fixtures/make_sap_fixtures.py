"""Generates SYNTHETIC SAP-style stock reports (made-up parts and numbers) that mimic the column layout of the real
'Stock Report' export, including its quirks. Run: python3 tests/fixtures/make_sap_fixtures.py   (needs openpyxl)."""
import csv, datetime as dt, os
from openpyxl import Workbook

HERE = os.path.dirname(os.path.abspath(__file__))
HEADERS = ['Company Code','Company Name','Branch Code','Branch Name','SAC Code','Storage Location No','Storage Location','Material Group','RO Code','RO Name','AO Code','AO Name','Zone','Part Code','Part Desc.','Leypart/NonLeypart','Parent','Primary Uom','Lot Quantity','Available Quantity','Issued Quantity','Reserved Quantity','IN-Transit','Blocked Quantity','Total Quantity','Cost','MRP','Current MRP','SUPPLIER INVOICE NO','SUPPLIER INVOICE DATE','Supplier Code','Supplier Name','Supplying Plant','Supplying Plant Name','GRN Date','Part-Bin Location','Lot-Bin Location','AMOUNT','Control code','Original Invoice No','MAKE','PO NUMBER','PO TYPE','ECC Order type','Blocked Bin','Blocked Reason','Blocked Remarks','Material Type']

def row(branch, part, desc, uom, lot, avail, issued, reserved, transit, blocked, cost, mrp, bin_, lotbin='BIN01'):
    total = avail + reserved + blocked          # physical stock = available + reserved + blocked (in-transit is not in the store)
    r = {h: '' for h in HEADERS}
    r.update({'Company Code':'D638','Company Name':'Test Motors','Branch Code':branch,'Branch Name':'Test-Branch','Storage Location No':'GS01','Storage Location':'Workshop',
              'Part Code':part,'Part Desc.':desc,'Leypart/NonLeypart':'LEYPARTS','Parent':'Parts','Primary Uom':uom,'Lot Quantity':lot,'Available Quantity':avail,
              'Issued Quantity':issued,'Reserved Quantity':reserved,'IN-Transit':transit,'Blocked Quantity':blocked,'Total Quantity':total,'Cost':cost,'MRP':mrp,'Current MRP':mrp,
              'SUPPLIER INVOICE DATE':dt.datetime(2025,1,5),'GRN Date':dt.datetime(2025,2,21),'Part-Bin Location':bin_,'Lot-Bin Location':lotbin,'AMOUNT':round(total*cost,2),'Material Type':'ZSPD'})
    return [r[h] for h in HEADERS]

def good_rows(branch='6696'):
    R = []
    R.append(row(branch,'AF-100','AIR FILTER','EA',5,5,0,0,0,0,400.0,650.0,'C01-E4'))
    R.append(row(branch,'AF-100','AIR FILTER','EA',3,3,0,0,0,0,420.0,650.0,'C01-E4'))          # second lot, same bin -> summed
    R.append(row(branch,'AF-100','AIR FILTER','EA',2,2,0,0,0,0,400.0,650.0,'D02-C2'))          # same part in a second bin
    R.append(row(branch,'SENS-1','SPEED SENSOR','EA',2,2,9,0,0,0,12500.0,15000.0,'PLAT'))      # sensitive (cost > 10000); issued qty must NOT count
    R.append(row(branch,'EDGE-10K','EXACTLY 10000','EA',1,1,0,0,0,0,10000.0,12000.0,'PLAT'))   # NOT sensitive: rule is "above" 10000
    R.append(row(branch,'EDGE-10K1','JUST ABOVE','EA',1,1,0,0,0,0,10000.01,12000.0,'PLAT'))    # sensitive
    R.append(row(branch,'OIL-5L','ENGINE OIL','L',12.5,12.5,0,0,0,0,300.0,420.0,'18_C'))      # fractional litres
    R.append(row(branch,'BLK-1','BLOCKED ITEM','EA',4,3,0,0,0,1,50.0,80.0,'10C'))              # blocked counts as physical stock (total 4)
    R.append(row(branch,'TRN-1','IN TRANSIT ITEM','EA',2,1,0,0,1,0,70.0,90.0,'10C'))           # in-transit not in the store (total 1)
    R.append(row(branch,'0000123','LEADING ZEROS TEXT','EA',1,1,0,0,0,0,10.0,15.0,'0'))        # text code with leading zeros; bin '0' -> no bin
    R.append(row(branch,4567,'NUMERIC CODE CELL','EA',2,2,0,0,0,0,25.0,40.0,''))                # numeric cell code; empty bin
    R.append(row(branch,'ZERO-1','ZERO STOCK','EA',0,0,0,0,0,0,99.0,120.0,'C01-E4'))
    R.append(row(branch,' sp-sp ','SPACES AND CASE','EA',1,1,0,0,0,0,5.0,9.0,' c01-e4 '))      # spaces / lower case
    return R

def write_xlsx(name, rows, declared=None, branch_in_title=True):
    wb = Workbook(); ws = wb.active; ws.title = 'Data'
    ws.append(['', f'Total Number of Lines: {len(rows) if declared is None else declared}'])
    ws.append([])
    ws.append(HEADERS)
    for r in rows: ws.append(r)
    wb.save(os.path.join(HERE, name))

good = good_rows()
write_xlsx('sap_good.xlsx', good)
write_xlsx('sap_truncated.xlsx', good, declared=len(good) + 5)               # file says 18 lines but only 13 present -> a cut-off export
mixed = good_rows() + [row('7001','OTHER-BRANCH','FROM ANOTHER BRANCH','EA',1,1,0,0,0,0,10.0,20.0,'A1')]
write_xlsx('sap_wrong_branch.xlsx', mixed)                                    # contains a second branch code
write_xlsx('sap_bad_number.xlsx', good + [row('6696','BADQTY','BAD','EA',1,1,0,0,0,0,1.0,1.0,'A1')[:24] + ['n/a'] + row('6696','x','x','EA',1,1,0,0,0,0,1.0,1.0,'A1')[25:]])
# a plain CSV of the same data (SAP/Excel "Save as CSV" style: no title rows)
with open(os.path.join(HERE, 'sap_good.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(HEADERS); [w.writerow(r) for r in good]
print('fixtures written:', sorted(x for x in os.listdir(HERE) if x.startswith('sap_')))
