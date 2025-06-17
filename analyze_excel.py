import pandas as pd

def analyze_excel():
    file_path = "Copy of 2025 Mar 29 - Apr 4.xlsx"
    
    # Read all sheets first
    excel_data = pd.read_excel(file_path, sheet_name=None, engine='openpyxl')
    print("\nSheets found in the Excel file:", list(excel_data.keys()))
    
    # Try to read the first sheet
    sheet_name = list(excel_data.keys())[0]
    df = excel_data[sheet_name]
    
    print(f"\nAnalyzing sheet: {sheet_name}")
    print(f"Number of rows: {len(df)}")
    print(f"Number of columns: {len(df.columns)}")
    print("\nColumn names:")
    for col in df.columns:
        print(f"- {col}")
    
    print("\nFirst 5 rows of data:")
    print(df.head())
    
    print("\nSample of non-empty values in each column:")
    for column in df.columns:
        non_empty = df[column].dropna().head(3)
        if len(non_empty) > 0:
            print(f"\n{column}:")
            print(non_empty.values)

if __name__ == "__main__":
    analyze_excel()