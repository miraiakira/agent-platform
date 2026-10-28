package httpapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"
)

type Transaction struct {
	ID         string `json:"id"`
	Amount     int64  `json:"amount"`
	Currency   string `json:"currency"`
	RiskScore  int    `json:"risk_score"`
	RiskLevel  string `json:"risk_level"`
	RiskReason string `json:"risk_reason"`
	CreatedAt  string `json:"created_at"`
}

type TransactionListResponse struct {
	Items []Transaction `json:"items"`
	Total int           `json:"total"`
}

func sampleTransactions() []Transaction {
	today := time.Now().UTC().Format("2006-01-02")

	return []Transaction{
		{"TX-1001", 125000, "USDT", 95, "HIGH",
			"Associated with a sanctioned address", today + "T01:00:00Z"},
		{"TX-1002", 88000, "USDT", 88, "HIGH",
			"Multiple rapid transfers through high-risk wallets", today + "T02:00:00Z"},
		{"TX-1003", 53000, "USDT", 82, "HIGH",
			"Exposure to a known mixer", today + "T03:00:00Z"},
		{"TX-1004", 12000, "USDT", 56, "MEDIUM",
			"Unusual transaction frequency", today + "T04:00:00Z"},
		{"TX-1005", 3000, "USDT", 12, "LOW",
			"No material risk indicators", today + "T05:00:00Z"},
	}
}

func highRiskTransactionsHandler(w http.ResponseWriter, r *http.Request) {
	date := r.URL.Query().Get("date")
	limit := 3

	if date == "" {
		http.Error(w, "date is required", http.StatusBadRequest)
		return
	}

	if _, err := time.Parse("2006-01-02", date); err != nil {
		http.Error(w, "invalid date", http.StatusBadRequest)
		return
	}

	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 20 {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = n
	}

	items := make([]Transaction, 0)

	for _, tx := range sampleTransactions() {
		if tx.RiskLevel == "HIGH" && tx.CreatedAt[:10] == date {
			items = append(items, tx)
		}
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].RiskScore > items[j].RiskScore
	})

	total := len(items)

	if len(items) > limit {
		items = items[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(TransactionListResponse{
		Items: items,
		Total: total,
	})
}
